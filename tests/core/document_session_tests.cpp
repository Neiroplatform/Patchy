#include "engine/document_session.hpp"

#include "core/smart_filter.hpp"
#include "core/smart_object.hpp"
#include "core/layer_metadata.hpp"
#include "core/vector_raster.hpp"
#include "core/vector_live_shapes.hpp"
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
using patchy::engine::AddAdjustmentLayer;
using patchy::engine::AddDocumentChannel;
using patchy::engine::AddPixelLayer;
using patchy::engine::AddVectorShapeLayer;
using patchy::engine::ApplyFilter;
using patchy::engine::CancellationToken;
using patchy::engine::CropDocument;
using patchy::engine::CommitSmartFilterState;
using patchy::engine::CommitPreviewedDocumentChannel;
using patchy::engine::CommitPreviewedLayerStates;
using patchy::engine::CommitVectorLayerStates;
using patchy::engine::DocumentSession;
using patchy::engine::FlipAxis;
using patchy::engine::FlipLayers;
using patchy::engine::MoveLayers;
using patchy::engine::ModifySelection;
using patchy::engine::InvertDocumentChannel;
using patchy::engine::open_psd;
using patchy::engine::PlaceLayers;
using patchy::engine::RemoveLayers;
using patchy::engine::RemoveDocumentChannel;
using patchy::engine::RenameLayer;
using patchy::engine::RenameDocumentChannel;
using patchy::engine::ReorderDocumentChannels;
using patchy::engine::ReplaceLayerPixels;
using patchy::engine::ResizeCanvas;
using patchy::engine::ResizeImage;
using patchy::engine::RasterizeVectorMask;
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
using patchy::engine::SetVectorMaskState;
using patchy::engine::SetLayersBlendMode;
using patchy::engine::SetLayersFillOpacity;
using patchy::engine::SetLayersOpacity;
using patchy::engine::SetSelection;
using patchy::engine::UngroupLayers;
using patchy::engine::TransformVectorLayers;
using patchy::engine::PreviewedLayerState;
using patchy::engine::UpdateAdjustmentLayer;
using patchy::engine::UpdateVectorShapeLayer;
using patchy::engine::VectorTransformTarget;
using patchy::engine::VectorMaskLayerState;
using patchy::engine::VectorShapeLayerState;
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

void engine_session_transient_preview_restores_without_canonical_mutation() {
  DocumentSession session(make_session_document());
  const auto layer_id = session.document().layers().front().id();
  const auto revision = session.revision();
  const auto state_id = session.state_id();
  const auto undo_size = session.undo_size();
  std::vector<SessionEvent> events;
  session.set_event_sink(
      [&events](const SessionEvent &event) { events.push_back(event); });

  CHECK(static_cast<bool>(session.begin_preview()));
  CHECK(session.preview_active());
  CHECK(events.back().kind == SessionEventKind::PreviewStarted);
  CHECK(events.back().revision == revision);
  CHECK(events.back().state_id == state_id);
  CHECK(!events.back().dirty);
  CHECK(!session.begin_preview());
  auto *previewed = session.mutable_document().find_layer(layer_id);
  CHECK(previewed != nullptr);
  previewed->set_name("Previewed");
  previewed->pixels().pixel(0, 0)[0] = 240;
  PixelBuffer temporary_pixels(session.document().width(),
                               session.document().height(),
                               PixelFormat::rgba8());
  temporary_pixels.clear(99);
  session.mutable_document().add_pixel_layer("Temporary",
                                             std::move(temporary_pixels));
  const auto updated = session.update_preview({0, 0, 2, 2}, layer_id);
  CHECK(static_cast<bool>(updated));
  CHECK(updated.affected_region.has_value());
  CHECK(events.back().kind == SessionEventKind::PreviewUpdated);
  CHECK(events.back().revision == revision);
  CHECK(events.back().state_id == state_id);
  CHECK(!events.back().dirty);
  CHECK(session.revision() == revision);
  CHECK(session.state_id() == state_id);
  CHECK(session.undo_size() == undo_size);
  CHECK(!session.dirty());
  CHECK(session.document().layers().size() == 2U);

  const auto rejected =
      session.execute(SetLayerVisibility{layer_id, false});
  CHECK(!rejected);
  CHECK(rejected.error.code == SessionErrorCode::InvalidArgument);
  CHECK(!session.undo());
  CHECK(!session.redo());
  const auto rejected_save = session.encode_psd();
  CHECK(!rejected_save);
  CHECK(rejected_save.error.code == SessionErrorCode::EncodeFailed);
  CHECK(static_cast<bool>(session.end_preview()));
  CHECK(!session.preview_active());
  CHECK(events.back().kind == SessionEventKind::PreviewEnded);
  CHECK(events.back().revision == revision);
  CHECK(events.back().state_id == state_id);
  CHECK(!events.back().dirty);
  CHECK(session.revision() == revision);
  CHECK(session.state_id() == state_id);
  CHECK(session.undo_size() == undo_size);
  CHECK(!session.dirty());
  CHECK(session.document().layers().size() == 1U);
  const auto *restored = session.document().find_layer(layer_id);
  CHECK(restored != nullptr);
  CHECK(restored->name() == "Layer 1");
  CHECK(restored->pixels().pixel(0, 0)[0] == 12);
  CHECK(!session.update_preview());
  CHECK(!session.end_preview());
  CHECK(static_cast<bool>(session.encode_psd()));
  CHECK(static_cast<bool>(
      session.execute(SetLayerVisibility{layer_id, false})));
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

void engine_session_vector_transforms_are_atomic_and_qt_free() {
  Document document(32, 24, PixelFormat::rgba8());
  PixelBuffer pixels(32, 24, PixelFormat::rgba8());
  const auto layer_id = document.allocate_layer_id();
  patchy::Layer layer(layer_id, "Vector mask", std::move(pixels));
  patchy::LayerVectorMask mask;
  patchy::LiveShapeParams rectangle;
  rectangle.kind = patchy::LiveShapeKind::Rectangle;
  rectangle.left = 4.0;
  rectangle.top = 3.0;
  rectangle.right = 14.0;
  rectangle.bottom = 12.0;
  mask.path.subpaths = patchy::generate_live_shape_subpaths(rectangle);
  layer.set_vector_mask(std::move(mask));
  patchy::update_vector_mask_raster(layer, {0, 0, 32, 24});
  document.add_layer(std::move(layer));
  DocumentSession session(std::move(document));

  const auto original = session.document()
                            .find_layer(layer_id)
                            ->vector_mask()
                            ->path.subpaths.front()
                            .anchors.front();
  const auto transformed = session.execute(TransformVectorLayers{
      {layer_id}, {1.0, 0.0, 0.0, 1.0, 5.0, 2.0}, 1.0,
      VectorTransformTarget::VectorMaskOnly});
  CHECK(static_cast<bool>(transformed));
  CHECK(transformed.affected_region.has_value());
  const auto moved = session.document()
                         .find_layer(layer_id)
                         ->vector_mask()
                         ->path.subpaths.front()
                         .anchors.front();
  CHECK(moved.anchor_x == original.anchor_x + 5.0);
  CHECK(moved.anchor_y == original.anchor_y + 2.0);
  CHECK(session.dirty());
  CHECK(static_cast<bool>(session.undo()));
  const auto restored = session.document()
                            .find_layer(layer_id)
                            ->vector_mask()
                            ->path.subpaths.front()
                            .anchors.front();
  CHECK(restored == original);
  CHECK(!session.dirty());

  const auto revision = session.revision();
  const auto rejected = session.execute(TransformVectorLayers{
      {layer_id, layer_id}, {1.0, 0.0, 0.0, 1.0, 1.0, 1.0}, 1.0,
      VectorTransformTarget::VectorMaskOnly});
  CHECK(!static_cast<bool>(rejected));
  CHECK(rejected.error.code == SessionErrorCode::InvalidArgument);
  CHECK(session.revision() == revision);
}

void engine_session_vector_mask_lifecycle_is_atomic_and_round_trips() {
  Document document(32, 24, PixelFormat::rgba8());
  PixelBuffer pixels(32, 24, PixelFormat::rgba8());
  pixels.clear(255);
  const auto layer_id = document.allocate_layer_id();
  patchy::Layer layer(layer_id, "Vector mask", std::move(pixels));
  layer.unknown_psd_blocks().push_back({"vmsk", {1, 2, 3}});
  layer.unknown_psd_blocks().push_back({"keep", {4, 5, 6}});
  document.add_layer(std::move(layer));
  DocumentSession session(std::move(document));

  patchy::LayerVectorMask mask;
  patchy::LiveShapeParams rectangle;
  rectangle.kind = patchy::LiveShapeKind::Rectangle;
  rectangle.left = 4.0;
  rectangle.top = 3.0;
  rectangle.right = 14.0;
  rectangle.bottom = 12.0;
  mask.path.subpaths = patchy::generate_live_shape_subpaths(rectangle);
  mask.inverted = true;
  mask.unlinked = true;
  mask.density = 192;
  mask.feather = 2.5;

  const auto added = session.execute(SetVectorMaskState{layer_id, mask});
  CHECK(static_cast<bool>(added));
  CHECK(added.affected_region.has_value());
  const auto *added_mask =
      session.document().find_layer(layer_id)->vector_mask();
  CHECK(added_mask != nullptr);
  CHECK(!added_mask->cache.empty());
  CHECK(added_mask->inverted);
  CHECK(added_mask->unlinked);
  CHECK(added_mask->density == 192);
  CHECK(added_mask->feather == 2.5);
  CHECK(session.dirty());

  const auto revision_after_add = session.revision();
  const auto noop = session.execute(SetVectorMaskState{layer_id, mask});
  CHECK(static_cast<bool>(noop));
  CHECK(session.revision() == revision_after_add);

  auto disabled = mask;
  disabled.disabled = true;
  CHECK(static_cast<bool>(
      session.execute(SetVectorMaskState{layer_id, disabled})));
  CHECK(session.document().find_layer(layer_id)->vector_mask()->disabled);
  CHECK(static_cast<bool>(session.undo()));
  CHECK(!session.document().find_layer(layer_id)->vector_mask()->disabled);

  const auto encoded = session.encode_psd();
  CHECK(static_cast<bool>(encoded));
  const auto reopened = open_psd(encoded.bytes);
  CHECK(static_cast<bool>(reopened));
  const auto *reopened_mask =
      reopened.session->document().find_layer(layer_id)->vector_mask();
  CHECK(reopened_mask != nullptr);
  CHECK(reopened_mask->path == mask.path);
  CHECK(reopened_mask->inverted);
  CHECK(reopened_mask->unlinked);
  CHECK(reopened_mask->density == 192);
  CHECK(reopened_mask->feather == 2.5);

  const auto rasterized = session.execute(RasterizeVectorMask{layer_id});
  CHECK(static_cast<bool>(rasterized));
  CHECK(rasterized.affected_region.has_value());
  const auto *rasterized_layer = session.document().find_layer(layer_id);
  CHECK(rasterized_layer->vector_mask() == nullptr);
  CHECK(rasterized_layer->mask().has_value());
  CHECK(rasterized_layer->mask()->pixels.width() == 32);
  CHECK(rasterized_layer->mask()->pixels.height() == 24);
  CHECK(static_cast<bool>(session.undo()));
  CHECK(session.document().find_layer(layer_id)->vector_mask() != nullptr);
  CHECK(!session.document().find_layer(layer_id)->mask().has_value());

  CHECK(static_cast<bool>(
      session.execute(SetVectorMaskState{layer_id, std::nullopt})));
  const auto *removed = session.document().find_layer(layer_id);
  CHECK(removed->vector_mask() == nullptr);
  CHECK(std::none_of(removed->unknown_psd_blocks().begin(),
                     removed->unknown_psd_blocks().end(),
                     [](const auto &block) { return block.key == "vmsk"; }));
  CHECK(std::any_of(removed->unknown_psd_blocks().begin(),
                    removed->unknown_psd_blocks().end(),
                    [](const auto &block) { return block.key == "keep"; }));

  const auto revision_before_rejections = session.revision();
  auto invalid = mask;
  invalid.feather = -1.0;
  const auto rejected =
      session.execute(SetVectorMaskState{layer_id, std::move(invalid)});
  CHECK(!static_cast<bool>(rejected));
  CHECK(rejected.error.code == SessionErrorCode::InvalidArgument);
  CHECK(session.revision() == revision_before_rejections);
  const auto missing = session.execute(RasterizeVectorMask{layer_id});
  CHECK(!static_cast<bool>(missing));
  CHECK(missing.error.code == SessionErrorCode::InvalidArgument);
  CHECK(session.revision() == revision_before_rejections);
}

void engine_session_vector_shape_authoring_is_atomic_and_round_trips() {
  DocumentSession session(Document(40, 30, PixelFormat::rgba8()));
  patchy::VectorShapeContent content;
  patchy::LiveShapeParams rectangle;
  rectangle.kind = patchy::LiveShapeKind::Rectangle;
  rectangle.left = 3.0;
  rectangle.top = 4.0;
  rectangle.right = 18.0;
  rectangle.bottom = 16.0;
  content.path.subpaths = patchy::generate_live_shape_subpaths(rectangle);
  content.origination = {rectangle};
  content.fill.kind = patchy::VectorFillKind::Solid;
  content.fill.color = {220, 30, 40};
  content.stroke.enabled = true;
  content.stroke.width = 2.0;
  content.stroke.content.kind = patchy::VectorFillKind::Solid;
  content.stroke.content.color = {10, 20, 30};

  const auto created = session.execute(AddVectorShapeLayer{
      "Rectangle 1", content, session.document().metadata().patterns, {}});
  CHECK(static_cast<bool>(created));
  CHECK(created.affected_layer_id != 0);
  CHECK(created.affected_region.has_value());
  const auto layer_id = created.affected_layer_id;
  const auto *layer = session.document().find_layer(layer_id);
  CHECK(layer != nullptr);
  CHECK(layer->vector_shape() != nullptr);
  CHECK(!layer->pixels().empty());
  CHECK(layer->metadata().at(patchy::kLayerMetadataVectorShape) == "1");

  const auto revision_before_noop = session.revision();
  const auto noop = session.execute(UpdateVectorShapeLayer{
      layer_id, content, session.document().metadata().patterns});
  CHECK(static_cast<bool>(noop));
  CHECK(session.revision() == revision_before_noop);

  auto updated = content;
  updated.path.subpaths.front().anchors.front().anchor_x += 5.0;
  updated.origination.clear();
  const auto changed = session.execute(UpdateVectorShapeLayer{
      layer_id, updated, session.document().metadata().patterns});
  CHECK(static_cast<bool>(changed));
  CHECK(changed.affected_region.has_value());
  CHECK(session.document().find_layer(layer_id)->vector_shape()->path ==
        updated.path);
  CHECK(static_cast<bool>(session.undo()));
  CHECK(session.document().find_layer(layer_id)->vector_shape()->path ==
        content.path);

  const auto encoded = session.encode_psd();
  CHECK(static_cast<bool>(encoded));
  const auto reopened = open_psd(encoded.bytes);
  CHECK(static_cast<bool>(reopened));
  const auto *reopened_layer =
      reopened.session->document().find_layer(layer_id);
  CHECK(reopened_layer != nullptr);
  CHECK(reopened_layer->vector_shape() != nullptr);
  CHECK(reopened_layer->vector_shape()->path.subpaths.size() ==
        content.path.subpaths.size());
  CHECK(std::abs(reopened_layer->vector_shape()
                     ->path.subpaths.front()
                     .anchors.front()
                     .anchor_x -
                 content.path.subpaths.front().anchors.front().anchor_x) <
        0.001);
  CHECK(reopened_layer->vector_shape()->fill == content.fill);
  CHECK(reopened_layer->vector_shape()->stroke == content.stroke);

  const auto revision_before_rejection = session.revision();
  const auto rejected = session.execute(AddVectorShapeLayer{
      "", content, session.document().metadata().patterns, {}});
  CHECK(!static_cast<bool>(rejected));
  CHECK(rejected.error.code == SessionErrorCode::InvalidArgument);
  CHECK(session.revision() == revision_before_rejection);
}

void engine_session_commits_previewed_vector_layer_states_atomically() {
  DocumentSession session(Document(64, 48, PixelFormat::rgba8()));
  patchy::VectorShapeContent content;
  patchy::LiveShapeParams rectangle;
  rectangle.kind = patchy::LiveShapeKind::Rectangle;
  rectangle.left = 4.0;
  rectangle.top = 5.0;
  rectangle.right = 24.0;
  rectangle.bottom = 22.0;
  content.path.subpaths = patchy::generate_live_shape_subpaths(rectangle);
  content.fill.kind = patchy::VectorFillKind::Solid;
  content.fill.color = {40, 120, 220};

  const auto first = session.execute(AddVectorShapeLayer{
      "Shape 1", content, session.document().metadata().patterns, {}});
  CHECK(static_cast<bool>(first));
  rectangle.left += 24.0;
  rectangle.right += 24.0;
  auto second_content = content;
  second_content.path.subpaths = patchy::generate_live_shape_subpaths(rectangle);
  const auto second = session.execute(AddVectorShapeLayer{
      "Shape 2", second_content, session.document().metadata().patterns, {}});
  CHECK(static_cast<bool>(second));

  PixelBuffer pixels(64, 48, PixelFormat::rgba8());
  pixels.clear(255);
  const auto mask_layer = session.execute(AddPixelLayer{"Masked", std::move(pixels), {}});
  CHECK(static_cast<bool>(mask_layer));
  patchy::LayerVectorMask mask;
  mask.path = content.path;
  CHECK(static_cast<bool>(session.execute(
      SetVectorMaskState{mask_layer.affected_layer_id, mask})));

  // Mirror the shell's cheap mouse-move preview: mutate the shared document
  // first, then publish all final states through one engine command.
  auto* first_layer = session.mutable_document().find_layer(first.affected_layer_id);
  auto* second_layer = session.mutable_document().find_layer(second.affected_layer_id);
  auto* masked_layer = session.mutable_document().find_layer(mask_layer.affected_layer_id);
  auto first_preview = *first_layer->vector_shape();
  auto second_preview = *second_layer->vector_shape();
  auto mask_preview = *masked_layer->vector_mask();
  first_preview.path.subpaths.front().anchors.front().anchor_x += 3.0;
  second_preview.path.subpaths.front().anchors.front().anchor_y += 4.0;
  mask_preview.path.subpaths.front().anchors.front().anchor_x += 5.0;
  first_layer->set_vector_shape(first_preview);
  second_layer->set_vector_shape(second_preview);
  masked_layer->set_vector_mask(mask_preview);

  const auto revision_before = session.revision();
  const auto state_before = session.state_id();
  const auto committed = session.execute_external(CommitVectorLayerStates{
      {{first.affected_layer_id, first_preview},
       {second.affected_layer_id, second_preview}},
      {{mask_layer.affected_layer_id, mask_preview}},
      session.document().metadata().patterns, {0, 0, 64, 48}});
  CHECK(static_cast<bool>(committed));
  CHECK(committed.affected_region.has_value());
  CHECK(committed.affected_region->x == 0);
  CHECK(committed.affected_region->y == 0);
  CHECK(committed.affected_region->width == 64);
  CHECK(committed.affected_region->height == 48);
  CHECK(session.revision() == revision_before + 1);
  CHECK(session.state_id() != state_before);
  CHECK(session.document().find_layer(first.affected_layer_id)
            ->vector_shape()->path == first_preview.path);
  CHECK(session.document().find_layer(second.affected_layer_id)
            ->vector_shape()->path == second_preview.path);
  CHECK(session.document().find_layer(mask_layer.affected_layer_id)
            ->vector_mask()->path == mask_preview.path);

  // Rejection is preflighted across the whole batch: a duplicate id cannot
  // partially publish or advance the revision.
  const auto revision_before_rejection = session.revision();
  const auto rejected = session.execute_external(CommitVectorLayerStates{
      {{first.affected_layer_id, first_preview},
       {first.affected_layer_id, first_preview}},
      {}, session.document().metadata().patterns, {}});
  CHECK(!static_cast<bool>(rejected));
  CHECK(rejected.error.code == SessionErrorCode::InvalidArgument);
  CHECK(session.revision() == revision_before_rejection);
}

void engine_session_commits_previewed_layer_states_atomically() {
  DocumentSession session(Document(32, 24, PixelFormat::rgba8()));
  PixelBuffer first_pixels(6, 5, PixelFormat::rgba8());
  first_pixels.clear(90);
  PixelBuffer second_pixels(4, 3, PixelFormat::rgba8());
  second_pixels.clear(180);
  const auto first = session.execute(
      AddPixelLayer{"First", std::move(first_pixels), {}});
  const auto second = session.execute(
      AddPixelLayer{"Second", std::move(second_pixels), {}});
  CHECK(static_cast<bool>(first));
  CHECK(static_cast<bool>(second));

  auto first_final = *session.document().find_layer(first.affected_layer_id);
  auto second_final = *session.document().find_layer(second.affected_layer_id);
  first_final.set_bounds({3, 4, 6, 5});
  second_final.set_bounds({14, 9, 4, 3});
  first_final.pixels().pixel(2, 1)[0] = 17;
  second_final.pixels().pixel(1, 1)[1] = 33;
  *session.mutable_document().find_layer(first.affected_layer_id) = first_final;
  *session.mutable_document().find_layer(second.affected_layer_id) = second_final;

  const auto revision_before = session.revision();
  const auto state_before = session.state_id();
  const auto committed = session.execute_external(CommitPreviewedLayerStates{
      {{first.affected_layer_id, first_final},
       {second.affected_layer_id, second_final}},
      {1, 2, 20, 14}});
  CHECK(static_cast<bool>(committed));
  CHECK(committed.changed);
  CHECK(committed.affected_region.has_value());
  CHECK(committed.affected_region->x == 1);
  CHECK(committed.affected_region->y == 2);
  CHECK(committed.affected_region->width == 20);
  CHECK(committed.affected_region->height == 14);
  CHECK(session.revision() == revision_before + 1);
  CHECK(session.state_id() != state_before);
  CHECK(session.document().find_layer(first.affected_layer_id)->bounds().x == 3);
  CHECK(session.document().find_layer(second.affected_layer_id)->bounds().x == 14);
  CHECK(session.document()
            .find_layer(first.affected_layer_id)
            ->pixels()
            .pixel(2, 1)[0] == 17);
  CHECK(session.document()
            .find_layer(second.affected_layer_id)
            ->pixels()
            .pixel(1, 1)[1] == 33);
  const auto encoded = session.encode_psd();
  CHECK(static_cast<bool>(encoded));
  const auto reopened = open_psd(encoded.bytes);
  CHECK(static_cast<bool>(reopened));
  CHECK(reopened.session->document()
            .find_layer(first.affected_layer_id)
            ->bounds()
            .x == 3);
  CHECK(reopened.session->document()
            .find_layer(second.affected_layer_id)
            ->bounds()
            .x == 14);
  CHECK(reopened.session->document()
            .find_layer(first.affected_layer_id)
            ->pixels()
            .pixel(2, 1)[0] == 17);
  CHECK(reopened.session->document()
            .find_layer(second.affected_layer_id)
            ->pixels()
            .pixel(1, 1)[1] == 33);

  const auto revision_before_rejection = session.revision();
  const auto rejected = session.execute_external(CommitPreviewedLayerStates{
      {{first.affected_layer_id, first_final},
       {first.affected_layer_id, first_final}},
      {}});
  CHECK(!static_cast<bool>(rejected));
  CHECK(rejected.error.code == SessionErrorCode::InvalidArgument);
  CHECK(session.revision() == revision_before_rejection);
}

void engine_session_commits_prepared_smart_filter_state_atomically() {
  Document document(3, 2, PixelFormat::rgba8());
  PixelBuffer pixels(3, 2, PixelFormat::rgba8());
  pixels.clear(40);
  const auto layer_id = document.allocate_layer_id();
  patchy::Layer layer(layer_id, "Smart Object", std::move(pixels));
  layer.metadata()[patchy::kLayerMetadataSmartObject] = "source-uuid";
  layer.unknown_psd_blocks().push_back({"SoLd", {1, 2, 3}});
  patchy::SmartFilterStack original_stack;
  original_stack.support = patchy::SmartFilterStackSupport::Supported;
  original_stack.entries.push_back(
      patchy::SmartFilterEntry{.kind = patchy::SmartFilterKind::GaussianBlur,
                               .parameters = patchy::GaussianBlurSmartFilter{2.0}});
  layer.set_smart_filter_stack(original_stack);
  document.add_layer(std::move(layer));
  DocumentSession session(std::move(document));

  auto updated_stack = original_stack;
  updated_stack.enabled = false;
  PixelBuffer rendered(3, 2, PixelFormat::rgba8());
  rendered.clear(90);
  CommitSmartFilterState command{
      layer_id, updated_stack, rendered, {0, 0, 3, 2}, {{0, {4, 5, 6}}}, {}};
  const auto committed = session.execute(command);
  CHECK(static_cast<bool>(committed));
  CHECK(committed.affected_region.has_value());
  const auto *updated = session.document().find_layer(layer_id);
  CHECK(updated != nullptr);
  CHECK(updated->smart_filter_stack() != nullptr);
  CHECK(!updated->smart_filter_stack()->enabled);
  CHECK(updated->pixels().pixel(0, 0)[0] == 90);
  CHECK(updated->unknown_psd_blocks().front().payload ==
        std::vector<std::uint8_t>({4, 5, 6}));
  CHECK(session.dirty());

  const auto committed_revision = session.revision();
  const auto no_op = session.execute(command);
  CHECK(static_cast<bool>(no_op));
  CHECK(!no_op.changed);
  CHECK(session.revision() == committed_revision);

  CHECK(static_cast<bool>(session.undo()));
  const auto *restored = session.document().find_layer(layer_id);
  CHECK(restored->smart_filter_stack()->enabled);
  CHECK(restored->pixels().pixel(0, 0)[0] == 40);
  CHECK(restored->unknown_psd_blocks().front().payload ==
        std::vector<std::uint8_t>({1, 2, 3}));
  CHECK(!session.dirty());

  auto invalid = command;
  invalid.regenerated_blocks.push_back({0, {7}});
  const auto revision = session.revision();
  const auto rejected = session.execute(invalid);
  CHECK(!static_cast<bool>(rejected));
  CHECK(rejected.error.code == SessionErrorCode::InvalidArgument);
  CHECK(session.revision() == revision);
}

void engine_session_commits_previewed_document_channel_atomically() {
  auto document = make_session_document();
  PixelBuffer pixels(2, 2, PixelFormat::gray8());
  pixels.clear(0);
  const auto channel_id = document.allocate_channel_id();
  document.add_channel(patchy::DocumentChannel(
      channel_id, "Alpha 1", patchy::DocumentChannelKind::Alpha,
      std::move(pixels)));
  DocumentSession session(std::move(document));
  session.mark_saved();

  auto *previewed = session.mutable_document().find_channel(channel_id);
  CHECK(previewed != nullptr);
  previewed->pixels().pixel(1, 0)[0] = 173;
  const auto final_channel = *previewed;
  const auto revision_before = session.revision();
  const auto state_before = session.state_id();
  const auto committed = session.execute_external(
      CommitPreviewedDocumentChannel{channel_id, final_channel, {1, 0, 1, 1}});
  CHECK(static_cast<bool>(committed));
  CHECK(committed.changed);
  CHECK(committed.affected_region.has_value());
  CHECK(committed.affected_region->x == 1);
  CHECK(committed.affected_region->width == 1);
  CHECK(session.revision() == revision_before + 1);
  CHECK(session.state_id() != state_before);
  CHECK(session.dirty());
  CHECK(session.document().find_channel(channel_id)->pixels().pixel(1, 0)[0] ==
        173);

  const auto encoded = session.encode_psd();
  CHECK(static_cast<bool>(encoded));
  const auto reopened = open_psd(encoded.bytes);
  CHECK(static_cast<bool>(reopened));
  CHECK(reopened.session->document()
            .find_channel(channel_id)
            ->pixels()
            .pixel(1, 0)[0] == 173);

  auto invalid = final_channel;
  invalid.set_pixels(PixelBuffer(1, 1, PixelFormat::gray8()));
  const auto revision_after = session.revision();
  const auto rejected = session.execute_external(
      CommitPreviewedDocumentChannel{channel_id, std::move(invalid), {}});
  CHECK(!static_cast<bool>(rejected));
  CHECK(rejected.error.code == SessionErrorCode::InvalidArgument);
  CHECK(session.revision() == revision_after);
}

void engine_session_owns_saved_channel_crud_history_and_round_trip() {
  DocumentSession session(make_session_document());
  session.mark_saved();
  const auto make_channel = [](patchy::ChannelId id, std::string name,
                               patchy::DocumentChannelKind kind,
                               std::uint8_t value) {
    PixelBuffer pixels(2, 2, PixelFormat::gray8());
    pixels.clear(value);
    return patchy::DocumentChannel(id, std::move(name), kind,
                                   std::move(pixels));
  };
  const auto apply = [&session](const auto &command) {
    const auto revision = session.revision();
    const auto state = session.state_id();
    const auto result = session.execute(command);
    CHECK(static_cast<bool>(result));
    CHECK(result.changed);
    CHECK(session.revision() == revision + 1);
    CHECK(session.state_id() != state);
  };

  apply(AddDocumentChannel{make_channel(
      100, "Alpha 1", patchy::DocumentChannelKind::Alpha, 10)});
  apply(AddDocumentChannel{make_channel(
      101, "Alpha 2", patchy::DocumentChannelKind::Alpha, 30)});
  apply(AddDocumentChannel{make_channel(
      102, "Spot", patchy::DocumentChannelKind::Spot, 50)});
  apply(RenameDocumentChannel{101, "Detail Mask"});
  apply(ReorderDocumentChannels{{101, 100, 102}});
  CHECK(session.document().channels().front().id() == 101);
  apply(InvertDocumentChannel{101});
  CHECK(session.document().find_channel(101)->pixels().pixel(0, 0)[0] == 225);
  apply(RemoveDocumentChannel{100});
  CHECK(session.document().find_channel(100) == nullptr);
  CHECK(session.dirty());

  const auto rejected_revision = session.revision();
  const auto rejected_order =
      session.execute(ReorderDocumentChannels{{102, 101}});
  CHECK(!static_cast<bool>(rejected_order));
  CHECK(rejected_order.error.code == SessionErrorCode::InvalidArgument);
  CHECK(!static_cast<bool>(session.execute(InvertDocumentChannel{102})));
  CHECK(!static_cast<bool>(session.execute(RemoveDocumentChannel{102})));
  CHECK(session.revision() == rejected_revision);

  CHECK(static_cast<bool>(session.undo()));
  CHECK(session.document().find_channel(100) != nullptr);
  CHECK(static_cast<bool>(session.redo()));
  CHECK(session.document().find_channel(100) == nullptr);

  const auto encoded = session.encode_psd();
  CHECK(static_cast<bool>(encoded));
  const auto reopened = open_psd(encoded.bytes);
  CHECK(static_cast<bool>(reopened));
  CHECK(reopened.session->document().channels().size() == 2);
  CHECK(reopened.session->document().channels()[0].name() == "Detail Mask");
  CHECK(reopened.session->document().channels()[0].pixels().pixel(0, 0)[0] ==
        225);
  CHECK(reopened.session->document().channels()[1].kind() ==
        patchy::DocumentChannelKind::Spot);
}

void engine_session_adjustment_layer_family_is_atomic_and_round_trips() {
  DocumentSession session(make_session_document());

  std::vector<patchy::AdjustmentSettings> settings(8);
  settings[0].kind = patchy::AdjustmentKind::Levels;
  settings[0].levels.black_input = 12;
  settings[1].kind = patchy::AdjustmentKind::Curves;
  settings[1].curves.rgb = {{0, 4}, {128, 150}, {255, 250}};
  settings[2].kind = patchy::AdjustmentKind::HueSaturation;
  settings[2].hue_saturation.hue_shift = 17;
  settings[3].kind = patchy::AdjustmentKind::ColorBalance;
  settings[3].color_balance.cyan_red = 21;
  settings[4].kind = patchy::AdjustmentKind::Invert;
  settings[5].kind = patchy::AdjustmentKind::Posterize;
  settings[5].posterize.levels = 9;
  settings[6].kind = patchy::AdjustmentKind::Threshold;
  settings[6].threshold.level = 143;
  settings[7].kind = patchy::AdjustmentKind::BrightnessContrast;
  settings[7].brightness_contrast.brightness = 24;
  settings[7].brightness_contrast.contrast = -12;

  patchy::LayerMask selection_mask;
  selection_mask.bounds = {0, 0, 1, 2};
  selection_mask.pixels = PixelBuffer(1, 2, PixelFormat::gray8());
  selection_mask.pixels.clear(190);
  std::vector<patchy::LayerId> ids;
  for (std::size_t index = 0; index < settings.size(); ++index) {
    const auto added = session.execute(AddAdjustmentLayer{
        "Adjustment " + std::to_string(index), settings[index],
        index == 0 ? std::optional<patchy::LayerMask>{selection_mask}
                   : std::nullopt});
    CHECK(static_cast<bool>(added));
    CHECK(added.affected_layer_id != 0);
    CHECK(added.affected_region.has_value());
    ids.push_back(added.affected_layer_id);
    const auto *layer = session.document().find_layer(ids.back());
    CHECK(layer != nullptr);
    CHECK(layer->kind() == patchy::LayerKind::Adjustment);
    CHECK(layer->bounds().width == session.document().width());
    const auto decoded = patchy::adjustment_settings_from_layer(*layer);
    CHECK(decoded.has_value());
    CHECK(decoded->kind == settings[index].kind);
  }
  CHECK(session.document().find_layer(ids.front())->mask().has_value());
  CHECK(session.document().active_layer_id() == ids.back());

  auto updated_settings = settings;
  updated_settings[0].levels.black_input = 32;
  updated_settings[1].curves.rgb[1].output = 177;
  updated_settings[2].hue_saturation.hue_shift = 31;
  updated_settings[3].color_balance.cyan_red = 33;
  updated_settings[5].posterize.levels = 12;
  updated_settings[6].threshold.level = 180;
  updated_settings[7].brightness_contrast.brightness = 31;
  std::size_t changed_updates = 0;
  for (std::size_t index = 0; index < updated_settings.size(); ++index) {
    const auto edited = session.execute(
        UpdateAdjustmentLayer{ids[index], updated_settings[index]});
    CHECK(static_cast<bool>(edited));
    const bool editable_kind =
        updated_settings[index].kind != patchy::AdjustmentKind::Invert;
    CHECK(edited.changed == editable_kind);
    if (editable_kind) {
      CHECK(edited.affected_region.has_value());
      ++changed_updates;
    }
    const auto edited_revision = session.revision();
    const auto no_op = session.execute(
        UpdateAdjustmentLayer{ids[index], updated_settings[index]});
    CHECK(static_cast<bool>(no_op));
    CHECK(!no_op.changed);
    CHECK(session.revision() == edited_revision);
  }
  auto decoded = patchy::adjustment_settings_from_layer(
      *session.document().find_layer(ids.front()));
  CHECK(decoded.has_value());
  CHECK(decoded->levels.black_input == 32);
  CHECK(changed_updates == 7);
  for (std::size_t index = 0; index < changed_updates; ++index) {
    CHECK(static_cast<bool>(session.undo()));
  }
  decoded = patchy::adjustment_settings_from_layer(
      *session.document().find_layer(ids.front()));
  CHECK(decoded.has_value());
  CHECK(decoded->levels.black_input == 12);

  const auto encoded = session.encode_psd();
  CHECK(static_cast<bool>(encoded));
  const auto reopened = open_psd(encoded.bytes);
  CHECK(static_cast<bool>(reopened));
  for (std::size_t index = 0; index < ids.size(); ++index) {
    const auto *layer = reopened.session->document().find_layer(ids[index]);
    CHECK(layer != nullptr);
    const auto round_tripped = patchy::adjustment_settings_from_layer(*layer);
    CHECK(round_tripped.has_value());
    CHECK(round_tripped->kind == settings[index].kind);
  }

  const auto revision = session.revision();
  const auto pixel_id = session.document().layers().front().id();
  const auto wrong_kind =
      session.execute(UpdateAdjustmentLayer{pixel_id, settings.front()});
  CHECK(!static_cast<bool>(wrong_kind));
  CHECK(wrong_kind.error.code == SessionErrorCode::InvalidArgument);
  auto invalid_mask = selection_mask;
  invalid_mask.bounds = {0, 0, 2, 2};
  const auto invalid_add = session.execute(AddAdjustmentLayer{
      "Invalid", settings.front(), std::move(invalid_mask)});
  CHECK(!static_cast<bool>(invalid_add));
  CHECK(invalid_add.error.code == SessionErrorCode::InvalidArgument);
  CHECK(session.revision() == revision);
}

} // namespace

std::vector<TestCase> document_session_tests() {
  return {
      {"engine_session_commands_history_dirty_and_events",
       engine_session_commands_history_dirty_and_events},
      {"engine_session_transient_preview_restores_without_canonical_mutation",
       engine_session_transient_preview_restores_without_canonical_mutation},
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
      {"engine_session_vector_transforms_are_atomic_and_qt_free",
       engine_session_vector_transforms_are_atomic_and_qt_free},
      {"engine_session_vector_mask_lifecycle_is_atomic_and_round_trips",
       engine_session_vector_mask_lifecycle_is_atomic_and_round_trips},
      {"engine_session_vector_shape_authoring_is_atomic_and_round_trips",
       engine_session_vector_shape_authoring_is_atomic_and_round_trips},
      {"engine_session_commits_previewed_vector_layer_states_atomically",
       engine_session_commits_previewed_vector_layer_states_atomically},
      {"engine_session_commits_previewed_layer_states_atomically",
       engine_session_commits_previewed_layer_states_atomically},
      {"engine_session_commits_previewed_document_channel_atomically",
       engine_session_commits_previewed_document_channel_atomically},
      {"engine_session_owns_saved_channel_crud_history_and_round_trip",
       engine_session_owns_saved_channel_crud_history_and_round_trip},
      {"engine_session_commits_prepared_smart_filter_state_atomically",
       engine_session_commits_prepared_smart_filter_state_atomically},
      {"engine_session_adjustment_layer_family_is_atomic_and_round_trips",
       engine_session_adjustment_layer_family_is_atomic_and_round_trips},
  };
}
