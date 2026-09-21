#include "engine/document_session.hpp"
#include "engine/host_protocol.h"

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
#include <cstring>
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
using patchy::engine::CommitPreparedSelection;
using patchy::engine::CommitPreparedDocumentState;
using patchy::engine::CommitVectorLayerStates;
using patchy::engine::DocumentSession;
using patchy::engine::FlipAxis;
using patchy::engine::FlipLayers;
using patchy::engine::MoveLayers;
using patchy::engine::ModifySelection;
using patchy::engine::InvertDocumentChannel;
using patchy::engine::OperationProgress;
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
using patchy::engine::SaveOperationProgress;
using patchy::engine::SavePhase;
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
using patchy::engine::SetLayerClipping;
using patchy::engine::SetLayerLockStates;
using patchy::engine::SetLayerMaskState;
using patchy::engine::SetLayerOpacity;
using patchy::engine::SetLayerVisibility;
using patchy::engine::SetLayersVisibility;
using patchy::engine::LayerLockState;
using patchy::engine::SetVectorMaskState;
using patchy::engine::SetLayersBlendMode;
using patchy::engine::SetLayersFillOpacity;
using patchy::engine::SetLayersOpacity;
using patchy::engine::SetSelection;
using patchy::engine::UngroupLayers;
using patchy::engine::TransformVectorLayers;
using patchy::engine::PreviewedLayerState;
using patchy::engine::PreparedDocumentMutationKind;
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

void engine_session_save_reports_progress_and_cancels_without_partial_bytes() {
  DocumentSession session(make_session_document());
  const auto baseline = session.encode_psd();
  CHECK(static_cast<bool>(baseline));

  std::vector<std::pair<SavePhase, std::uint64_t>> updates;
  const SaveOperationProgress progress{
      [&updates](SavePhase phase, std::uint64_t bytes) {
        updates.emplace_back(phase, bytes);
        return true;
      }};
  const auto progressive = session.encode_psd(false, nullptr, &progress);
  CHECK(static_cast<bool>(progressive));
  CHECK(progressive.bytes == baseline.bytes);
  CHECK(!updates.empty());
  CHECK(updates.front().first == SavePhase::Started);
  CHECK(updates.back().first == SavePhase::Complete);
  CHECK(updates.back().second == progressive.bytes.size());
  for (std::size_t index = 1; index < updates.size(); ++index) {
    CHECK(static_cast<std::uint8_t>(updates[index - 1].first) <=
          static_cast<std::uint8_t>(updates[index].first));
    if (updates[index].first == SavePhase::Serializing &&
        updates[index - 1].first == SavePhase::Serializing) {
      CHECK(updates[index - 1].second <= updates[index].second);
    }
  }

  const SaveOperationProgress cancel_during_encoding{
      [](SavePhase phase, std::uint64_t) {
        return phase != SavePhase::EncodingLayers;
      }};
  const auto cancelled =
      session.encode_psd(false, nullptr, &cancel_during_encoding);
  CHECK(!static_cast<bool>(cancelled));
  CHECK(cancelled.error.code == SessionErrorCode::Cancelled);
  CHECK(cancelled.bytes.empty());

  CancellationToken cancellation;
  cancellation.cancel();
  const auto pre_cancelled = session.encode_psd(false, &cancellation);
  CHECK(!static_cast<bool>(pre_cancelled));
  CHECK(pre_cancelled.error.code == SessionErrorCode::Cancelled);
  CHECK(pre_cancelled.bytes.empty());
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

  Document tall_document(8, 130, PixelFormat::rgba8());
  PixelBuffer tall_pixels(8, 130, PixelFormat::rgba8());
  for (std::int32_t y = 0; y < tall_pixels.height(); ++y) {
    for (std::int32_t x = 0; x < tall_pixels.width(); ++x) {
      auto *pixel = tall_pixels.pixel(x, y);
      pixel[0] = static_cast<std::uint8_t>((x * 19 + y) % 256);
      pixel[1] = static_cast<std::uint8_t>((x + y * 3) % 256);
      pixel[2] = static_cast<std::uint8_t>((x * 7 + y * 5) % 256);
      pixel[3] = 255;
    }
  }
  tall_document.add_pixel_layer("Tall", std::move(tall_pixels));
  DocumentSession tall_session(std::move(tall_document));
  const auto one_shot = tall_session.render({0, 0, 8, 130});
  CHECK(static_cast<bool>(one_shot));
  std::vector<std::int32_t> progress_rows;
  const OperationProgress progress{
      [&progress_rows](std::int32_t completed, std::int32_t) {
        progress_rows.push_back(completed);
        return true;
      }};
  const auto progressive =
      tall_session.render({0, 0, 8, 130}, nullptr, &progress);
  CHECK(static_cast<bool>(progressive));
  CHECK(progressive.pixels.data().size() == one_shot.pixels.data().size());
  CHECK(std::equal(progressive.pixels.data().begin(),
                   progressive.pixels.data().end(),
                   one_shot.pixels.data().begin()));
  CHECK(progress_rows.size() == 4U);
  CHECK(progress_rows.front() == 0);
  CHECK(progress_rows.back() == 130);
  CHECK(std::is_sorted(progress_rows.begin(), progress_rows.end()));

  const OperationProgress cancel_after_first_band{
      [](std::int32_t completed, std::int32_t) { return completed < 64; }};
  const auto progress_cancelled =
      tall_session.render({0, 0, 8, 130}, nullptr,
                          &cancel_after_first_band);
  CHECK(!static_cast<bool>(progress_cancelled));
  CHECK(progress_cancelled.error.code == SessionErrorCode::Cancelled);
  CHECK(progress_cancelled.pixels.empty());
}

void engine_session_coalesces_dirty_render_regions_and_publishes_them() {
  Document document(12, 10, PixelFormat::rgba8());
  PixelBuffer first_pixels(2, 3, PixelFormat::rgba8());
  first_pixels.clear(80);
  const auto first_id = document.allocate_layer_id();
  patchy::Layer first(first_id, "First", std::move(first_pixels));
  first.set_bounds({1, 1, 2, 3});
  document.add_layer(std::move(first));
  PixelBuffer second_pixels(3, 2, PixelFormat::rgba8());
  second_pixels.clear(160);
  const auto second_id = document.allocate_layer_id();
  patchy::Layer second(second_id, "Second", std::move(second_pixels));
  second.set_bounds({7, 6, 3, 2});
  document.add_layer(std::move(second));

  DocumentSession session(std::move(document));
  std::vector<SessionEvent> events;
  session.set_event_sink(
      [&events](const SessionEvent &event) { events.push_back(event); });
  CHECK(!session.pending_render_region().has_value());

  const auto first_result = session.execute(SetLayerOpacity{first_id, 0.5F});
  CHECK(static_cast<bool>(first_result));
  CHECK(first_result.affected_region.has_value());
  CHECK(events.back().affected_region.has_value());
  CHECK(events.back().affected_region->x == first_result.affected_region->x);
  CHECK(events.back().affected_region->y == first_result.affected_region->y);
  CHECK(events.back().affected_region->width ==
        first_result.affected_region->width);
  CHECK(events.back().affected_region->height ==
        first_result.affected_region->height);
  const auto second_result =
      session.execute(SetLayerVisibility{second_id, false});
  CHECK(static_cast<bool>(second_result));
  CHECK(second_result.affected_region.has_value());
  CHECK(events.back().affected_region.has_value());
  CHECK(events.back().affected_region->x == second_result.affected_region->x);
  CHECK(events.back().affected_region->y == second_result.affected_region->y);
  CHECK(events.back().affected_region->width ==
        second_result.affected_region->width);
  CHECK(events.back().affected_region->height ==
        second_result.affected_region->height);

  const auto pending = session.pending_render_region();
  CHECK(pending.has_value());
  CHECK(pending->x == 1);
  CHECK(pending->y == 1);
  CHECK(pending->width == 9);
  CHECK(pending->height == 7);
  const auto taken = session.take_pending_render_region();
  CHECK(taken.has_value());
  CHECK(taken->x == pending->x);
  CHECK(taken->y == pending->y);
  CHECK(taken->width == pending->width);
  CHECK(taken->height == pending->height);
  CHECK(!session.pending_render_region().has_value());

  CHECK(static_cast<bool>(session.execute(RenameLayer{first_id, "Renamed"})));
  CHECK(!session.pending_render_region().has_value());
  CHECK(!events.back().affected_region.has_value());

  CHECK(static_cast<bool>(session.begin_preview()));
  CHECK(static_cast<bool>(session.update_preview({3, 2, 4, 5}, first_id)));
  CHECK(events.back().affected_region.has_value());
  CHECK(events.back().affected_region->x == 3);
  CHECK(!session.pending_render_region().has_value());
  CHECK(static_cast<bool>(session.end_preview()));

  const auto undone = session.undo();
  CHECK(static_cast<bool>(undone));
  CHECK(undone.affected_region.has_value());
  CHECK(undone.affected_region->x == 0);
  CHECK(undone.affected_region->y == 0);
  CHECK(undone.affected_region->width == 12);
  CHECK(undone.affected_region->height == 10);
  const auto undo_pending = session.pending_render_region();
  CHECK(undo_pending.has_value());
  CHECK(undo_pending->x == undone.affected_region->x);
  CHECK(undo_pending->y == undone.affected_region->y);
  CHECK(undo_pending->width == undone.affected_region->width);
  CHECK(undo_pending->height == undone.affected_region->height);

  session.replace_external(make_session_document(), true);
  const auto replaced_pending = session.pending_render_region();
  CHECK(replaced_pending.has_value());
  CHECK(replaced_pending->x == 0);
  CHECK(replaced_pending->y == 0);
  CHECK(replaced_pending->width == 2);
  CHECK(replaced_pending->height == 2);
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

  const auto shell_state = session.state_id();
  const auto shell_layer_id = session.document().layers().front().id();
  session.push_external_undo_state(session.document(), shell_state,
                                   session.selection());
  session.mutable_document().find_layer(shell_layer_id)->set_visible(false);
  session.mark_external_modified();
  CHECK(session.undo_size() == 1);
  CHECK(session.undo_document(0) != nullptr);
  CHECK(session.undo_document(0)->find_layer(shell_layer_id)->visible());
  CHECK(static_cast<bool>(session.undo()));
  CHECK(session.document().find_layer(shell_layer_id)->visible());
  CHECK(static_cast<bool>(session.redo()));
  CHECK(!session.document().find_layer(shell_layer_id)->visible());
  session.clear_history();
  CHECK(!session.can_undo());
  CHECK(!session.can_redo());
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

void engine_session_memory_census_is_cow_aware_across_owned_state() {
  DocumentSession session(make_session_document());
  const auto layer_id = session.document().layers().front().id();
  const auto initial = session.memory_usage();
  CHECK(initial.document_pixel_bytes == 16U);
  CHECK(initial.history_retained_bytes == 0U);
  CHECK(initial.total_retained_bytes == 16U);
  CHECK(initial.undo_states == 0U);
  CHECK(initial.redo_states == 0U);

  CHECK(static_cast<bool>(
      session.execute(SetLayerVisibility{layer_id, false})));
  const auto shared_history = session.memory_usage();
  CHECK(shared_history.document_pixel_bytes == 16U);
  CHECK(shared_history.history_pixel_bytes == 0U);
  CHECK(shared_history.history_retained_bytes == 0U);
  CHECK(shared_history.undo_states == 1U);

  PixelBuffer replacement(2, 2, PixelFormat::rgba8());
  replacement.clear(210);
  CHECK(static_cast<bool>(session.execute(
      ReplaceLayerPixels{layer_id, std::move(replacement), {0, 0, 2, 2}})));
  const auto detached_history = session.memory_usage();
  CHECK(detached_history.document_pixel_bytes == 16U);
  CHECK(detached_history.history_pixel_bytes == 16U);
  CHECK(detached_history.history_retained_bytes == 16U);
  CHECK(detached_history.total_retained_bytes == 32U);
  CHECK(detached_history.undo_states == 2U);

  SelectionSnapshot first_selection;
  first_selection.selection = {{0, 0, 1, 1}};
  first_selection.display_region = first_selection.selection;
  first_selection.mask_bounds = {0, 0, 1, 1};
  first_selection.mask_alpha = PixelBuffer(1, 1, PixelFormat::gray8());
  *first_selection.mask_alpha.pixel(0, 0) = 128;
  CHECK(static_cast<bool>(
      session.execute(SetSelection{std::move(first_selection)})));
  SelectionSnapshot second_selection;
  second_selection.selection = {{1, 1, 1, 1}};
  second_selection.display_region = second_selection.selection;
  CHECK(static_cast<bool>(
      session.execute(SetSelection{std::move(second_selection)})));
  const auto selection_history = session.memory_usage();
  CHECK(selection_history.selection_bytes > 0U);
  CHECK(selection_history.history_selection_bytes > 0U);
  CHECK(selection_history.history_retained_bytes ==
        selection_history.history_pixel_bytes +
            selection_history.history_selection_bytes);
  CHECK(selection_history.total_retained_bytes ==
        selection_history.document_pixel_bytes +
            selection_history.history_pixel_bytes +
            selection_history.preview_pixel_bytes +
            selection_history.selection_bytes +
            selection_history.history_selection_bytes +
            selection_history.preview_selection_bytes);

  CHECK(static_cast<bool>(session.begin_preview()));
  const auto preview = session.memory_usage();
  CHECK(preview.preview_pixel_bytes == 0U);
  CHECK(preview.preview_selection_bytes > 0U);
  CHECK(static_cast<bool>(session.end_preview()));
  CHECK(session.memory_usage().preview_selection_bytes == 0U);
}

void engine_session_prepared_selection_commit_rejects_stale_gestures() {
  DocumentSession session(make_session_document());
  const auto initial_revision = session.revision();
  const auto initial_state_id = session.state_id();
  const auto before = session.selection();

  SelectionSnapshot prepared;
  prepared.selection = {{0, 0, 1, 2}};
  prepared.display_region = prepared.selection;
  const auto committed = session.execute(
      CommitPreparedSelection{before, prepared});
  CHECK(static_cast<bool>(committed));
  CHECK(committed.changed);
  CHECK(session.selection().selection.size() == 1U);
  CHECK(session.revision() == initial_revision + 1U);
  CHECK(session.state_id() == initial_state_id);
  CHECK(session.undo_size() == 1U);
  CHECK(!session.dirty());

  SelectionSnapshot late_result;
  late_result.selection = {{1, 0, 1, 2}};
  late_result.display_region = late_result.selection;
  const auto revision_before_stale = session.revision();
  const auto undo_before_stale = session.undo_size();
  const auto stale = session.execute(
      CommitPreparedSelection{before, std::move(late_result)});
  CHECK(!static_cast<bool>(stale));
  CHECK(stale.error.code == SessionErrorCode::CommandFailed);
  CHECK(session.revision() == revision_before_stale);
  CHECK(session.undo_size() == undo_before_stale);
  CHECK(session.selection().selection.front().x == 0);

  CHECK(static_cast<bool>(session.undo()));
  CHECK(session.selection().empty());
  CHECK(static_cast<bool>(session.redo()));
  CHECK(session.selection().selection.size() == 1U);
  CHECK(session.selection().selection.front().x == 0);

  DocumentSession quick_mask_session(make_session_document());
  SelectionSnapshot quick_mask_before;
  quick_mask_before.quick_mask_pixels =
      PixelBuffer(2, 2, PixelFormat::gray8());
  quick_mask_before.quick_mask_pixels->clear(0);
  auto quick_mask_after = quick_mask_before;
  quick_mask_after.quick_mask_pixels->clear(128);
  const auto quick_mask_commit = quick_mask_session.execute(
      CommitPreparedSelection{quick_mask_before, quick_mask_after});
  CHECK(static_cast<bool>(quick_mask_commit));
  CHECK(quick_mask_session.selection().quick_mask_pixels.has_value());
  CHECK(quick_mask_session.selection().quick_mask_pixels->pixel(0, 0)[0] ==
        128U);

  DocumentSession equivalent_region_session(make_session_document());
  SelectionSnapshot canonical_region;
  canonical_region.selection = {{0, 0, 2, 2}};
  canonical_region.display_region = canonical_region.selection;
  canonical_region.mask_bounds = {0, 0, 2, 2};
  canonical_region.mask_alpha = PixelBuffer(2, 2, PixelFormat::gray8());
  canonical_region.mask_alpha.clear(255);
  CHECK(static_cast<bool>(equivalent_region_session.execute(
      SetSelection{canonical_region})));
  auto equivalent_before = canonical_region;
  equivalent_before.selection = {{0, 0, 2, 1}, {0, 1, 2, 1}};
  equivalent_before.display_region = equivalent_before.selection;
  auto equivalent_after = canonical_region;
  equivalent_after.selection = {{1, 0, 1, 2}};
  equivalent_after.display_region = equivalent_after.selection;
  equivalent_after.mask_bounds = {1, 0, 1, 2};
  equivalent_after.mask_alpha = PixelBuffer(1, 2, PixelFormat::gray8());
  equivalent_after.mask_alpha.clear(255);
  CHECK(static_cast<bool>(equivalent_region_session.execute(
      CommitPreparedSelection{equivalent_before, equivalent_after})));
  CHECK(equivalent_region_session.selection().mask_bounds.x == 1);

  DocumentSession hard_region_session(make_session_document());
  SelectionSnapshot canonical_hard_region;
  canonical_hard_region.selection = {{0, 0, 2, 1}, {0, 1, 2, 1}};
  canonical_hard_region.display_region = canonical_hard_region.selection;
  CHECK(static_cast<bool>(
      hard_region_session.execute(SetSelection{canonical_hard_region})));
  auto coalesced_before = canonical_hard_region;
  coalesced_before.selection = {{0, 0, 2, 2}};
  coalesced_before.display_region = coalesced_before.selection;
  SelectionSnapshot hard_region_after;
  hard_region_after.selection = {{1, 0, 1, 2}};
  hard_region_after.display_region = hard_region_after.selection;
  CHECK(static_cast<bool>(hard_region_session.execute(CommitPreparedSelection{
      coalesced_before, hard_region_after})));
  CHECK(hard_region_session.selection().selection.front().x == 1);
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

void engine_session_nondestructive_layer_state_is_atomic_and_round_trips() {
  Document document(2, 2, PixelFormat::rgba8());
  PixelBuffer base_pixels(2, 2, PixelFormat::rgba8());
  base_pixels.clear(255);
  patchy::Layer base(document.allocate_layer_id(), "Base",
                     std::move(base_pixels));
  const auto base_id = base.id();
  document.add_layer(std::move(base));
  PixelBuffer upper_pixels(2, 2, PixelFormat::rgba8());
  upper_pixels.clear(180);
  patchy::Layer upper(document.allocate_layer_id(), "Upper",
                      std::move(upper_pixels));
  const auto upper_id = upper.id();
  document.add_layer(std::move(upper));
  DocumentSession session(std::move(document));

  auto result = session.execute(
      SetLayersVisibility{{base_id, upper_id}, false});
  CHECK(static_cast<bool>(result));
  CHECK(result.changed);
  CHECK(!session.document().find_layer(base_id)->visible());
  CHECK(!session.document().find_layer(upper_id)->visible());

  const auto lock_revision = session.revision();
  result = session.execute(SetLayerLockStates{
      {LayerLockState{base_id, patchy::kLayerLockAll},
       LayerLockState{upper_id, patchy::kLayerLockPosition}}});
  CHECK(static_cast<bool>(result));
  CHECK(session.revision() == lock_revision + 1U);
  CHECK(session.document().find_layer(base_id)->lock_flags() ==
        patchy::kLayerLockAll);
  CHECK(session.document().find_layer(upper_id)->lock_flags() ==
        patchy::kLayerLockPosition);

  result = session.execute(SetLayerClipping{upper_id, true});
  CHECK(static_cast<bool>(result));
  CHECK(result.affected_region.has_value());
  CHECK(session.document().find_layer(upper_id)->clipped());

  patchy::LayerMask mask;
  mask.bounds = {0, 0, 2, 2};
  mask.pixels = PixelBuffer(2, 2, PixelFormat::gray8());
  mask.pixels.clear(255);
  *mask.pixels.pixel(1, 1) = 0;
  mask.default_color = 255;
  result = session.execute(
      SetLayerMaskState{upper_id, mask, false});
  CHECK(static_cast<bool>(result));
  const auto *masked = session.document().find_layer(upper_id);
  CHECK(masked->mask().has_value());
  CHECK(!patchy::layer_mask_linked(*masked));
  CHECK(masked->mask()->pixels.pixel(1, 1)[0] == 0U);

  const auto revision_before_invalid = session.revision();
  const auto invalid = session.execute(SetLayerLockStates{
      {LayerLockState{base_id, patchy::kLayerLockNone},
       LayerLockState{base_id, patchy::kLayerLockAll}}});
  CHECK(!static_cast<bool>(invalid));
  CHECK(invalid.error.code == SessionErrorCode::InvalidArgument);
  CHECK(session.revision() == revision_before_invalid);
  CHECK(session.document().find_layer(base_id)->lock_flags() ==
        patchy::kLayerLockAll);

  const auto encoded = session.encode_psd();
  CHECK(static_cast<bool>(encoded));
  const auto reopened = open_psd(encoded.bytes);
  CHECK(static_cast<bool>(reopened));
  const auto *reopened_upper = reopened.session->document().find_layer(upper_id);
  CHECK(reopened_upper != nullptr);
  CHECK(reopened_upper->clipped());
  CHECK(reopened_upper->mask().has_value());
  CHECK(!patchy::layer_mask_linked(*reopened_upper));
  CHECK(reopened_upper->lock_flags() == patchy::kLayerLockPosition);

  CHECK(static_cast<bool>(session.undo()));
  CHECK(!session.document().find_layer(upper_id)->mask().has_value());
  CHECK(static_cast<bool>(session.undo()));
  CHECK(!session.document().find_layer(upper_id)->clipped());
  CHECK(static_cast<bool>(session.redo()));
  CHECK(session.document().find_layer(upper_id)->clipped());
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

void engine_session_commits_prepared_document_state_with_stale_guard() {
  DocumentSession session(make_session_document());
  const auto original = session.document();
  const auto original_state_id = session.state_id();
  auto prepared = original;
  prepared.metadata().values["patchy.test.prepared"] = "path";
  prepared.find_layer(prepared.layers().front().id())->set_name("Prepared");

  const auto committed = session.execute(CommitPreparedDocumentState{
      PreparedDocumentMutationKind::Path, original_state_id, prepared,
      {0, 0, 1, 1}});
  CHECK(static_cast<bool>(committed));
  CHECK(committed.changed);
  CHECK(committed.affected_region.has_value());
  CHECK(committed.affected_region->x == 0);
  CHECK(committed.affected_region->y == 0);
  CHECK(committed.affected_region->width == 1);
  CHECK(committed.affected_region->height == 1);
  CHECK(session.document().layers().front().name() == "Prepared");
  CHECK(session.document().metadata().values.at("patchy.test.prepared") ==
        "path");
  CHECK(session.undo_size() == 1);
  CHECK(static_cast<bool>(session.undo()));
  CHECK(session.document().layers().front().name() == "Layer 1");
  CHECK(!session.document().metadata().values.contains("patchy.test.prepared"));
  CHECK(static_cast<bool>(session.redo()));
  CHECK(session.document().layers().front().name() == "Prepared");

  auto stale = session.document();
  stale.find_layer(stale.layers().front().id())->set_name("Stale");
  const auto revision_before_rejection = session.revision();
  const auto rejected = session.execute(CommitPreparedDocumentState{
      PreparedDocumentMutationKind::SmartObject, original_state_id,
      std::move(stale), {}});
  CHECK(!static_cast<bool>(rejected));
  CHECK(rejected.error.code == SessionErrorCode::InvalidArgument);
  CHECK(session.revision() == revision_before_rejection);
  CHECK(session.document().layers().front().name() == "Prepared");

  Document wrong_geometry(3, 2, PixelFormat::rgba8());
  wrong_geometry.add_pixel_layer(
      "Wrong", PixelBuffer(3, 2, PixelFormat::rgba8()));
  const auto wrong = session.execute(CommitPreparedDocumentState{
      PreparedDocumentMutationKind::MergeRasterize, session.state_id(),
      std::move(wrong_geometry), {}});
  CHECK(!static_cast<bool>(wrong));
  CHECK(wrong.error.code == SessionErrorCode::InvalidArgument);
}

void engine_host_protocol_runs_versioned_native_wasm_sequence() {
  patchy_engine_error error{};
  patchy_engine_protocol_info info{};
  info.struct_size = sizeof(info);
  CHECK(patchy_engine_get_protocol_info(&info, &error) == 1);
  CHECK(info.protocol_version == PATCHY_ENGINE_HOST_PROTOCOL_VERSION);
  CHECK((info.capabilities & PATCHY_ENGINE_CAP_BOUNDED_RENDER) != 0);
  CHECK((info.capabilities & PATCHY_ENGINE_CAP_PSD_SAVE) != 0);
  CHECK((info.capabilities & PATCHY_ENGINE_CAP_DOCUMENT_PROJECTION) != 0);
  CHECK((info.capabilities & PATCHY_ENGINE_CAP_LAYER_APPEARANCE) != 0);
  CHECK((info.capabilities & PATCHY_ENGINE_CAP_LAYER_LIFECYCLE) != 0);
  CHECK((info.capabilities & PATCHY_ENGINE_CAP_DOCUMENT_GEOMETRY) != 0);
  CHECK((info.capabilities & PATCHY_ENGINE_CAP_OPTIMISTIC_COMMANDS) != 0);
  CHECK((info.capabilities & PATCHY_ENGINE_CAP_SAVE_STATE) != 0);
  CHECK((info.capabilities & PATCHY_ENGINE_CAP_SELECTION_PROJECTION) != 0);
  CHECK((info.capabilities & PATCHY_ENGINE_CAP_SAVED_CHANNELS) != 0);
  CHECK((info.capabilities & PATCHY_ENGINE_CAP_PIXEL_AUTHORING) != 0);
  CHECK((info.capabilities & PATCHY_ENGINE_CAP_PATH_PROJECTION) != 0);
  CHECK((info.capabilities & PATCHY_ENGINE_CAP_VECTOR_AUTHORING) != 0);

  auto *unsupported = patchy_engine_runtime_create(
      PATCHY_ENGINE_HOST_PROTOCOL_VERSION + 1U, &error);
  CHECK(unsupported == nullptr);
  CHECK(error.code == PATCHY_ENGINE_ERROR_UNSUPPORTED_VERSION);

  auto source = DocumentSession(make_session_document());
  const auto encoded = source.encode_psd();
  CHECK(static_cast<bool>(encoded));

  auto *runtime = patchy_engine_runtime_create(
      PATCHY_ENGINE_HOST_PROTOCOL_VERSION, &error);
  CHECK(runtime != nullptr);
  auto *session = patchy_engine_session_open_psd(
      runtime, encoded.bytes.data(), encoded.bytes.size(), &error);
  CHECK(session != nullptr);
  std::size_t layer_count = 0;
  CHECK(patchy_engine_session_layer_count(session, &layer_count, &error) == 1);
  CHECK(layer_count == 1);

  patchy_engine_layer_projection layer{};
  CHECK(patchy_engine_session_layer_at(session, 0, &layer, &error) == 1);
  CHECK(layer.id != 0);
  CHECK(layer.visible == 1);

  patchy_engine_buffer initial_render{};
  patchy_engine_event event{};
  CHECK(patchy_engine_session_render(
            session, {0, 0, 2, 2}, &initial_render, &event, &error) == 1);
  CHECK(initial_render.size == 16);
  const std::vector<std::uint8_t> initial_pixels(
      initial_render.data, initial_render.data + initial_render.size);
  patchy_engine_buffer_release(&initial_render);

  patchy_engine_command command{};
  command.struct_size = sizeof(command);
  command.protocol_version = PATCHY_ENGINE_HOST_PROTOCOL_VERSION;
  command.type = PATCHY_ENGINE_COMMAND_SET_LAYER_VISIBILITY;
  command.expected_state_id = event.state_id;
  command.expected_revision = event.revision;
  command.payload.set_layer_visibility.layer_id = layer.id;
  command.payload.set_layer_visibility.visible = 0;
  CHECK(patchy_engine_session_execute(session, &command, &event, &error) == 1);
  CHECK(event.changed == 1);
  CHECK(event.dirty == 1);
  const auto changed_revision = event.revision;

  CHECK(patchy_engine_session_undo(session, &event, &error) == 1);
  CHECK(event.revision > changed_revision);
  patchy_engine_buffer restored_render{};
  CHECK(patchy_engine_session_render(
            session, {0, 0, 2, 2}, &restored_render, &event, &error) == 1);
  CHECK(std::vector<std::uint8_t>(restored_render.data,
                                  restored_render.data + restored_render.size) ==
        initial_pixels);
  patchy_engine_buffer_release(&restored_render);

  CHECK(patchy_engine_session_redo(session, &event, &error) == 1);
  patchy_engine_buffer psd{};
  CHECK(patchy_engine_session_save_psd(session, &psd, &event, &error) == 1);
  CHECK(psd.size > 0);
  auto *reopened = patchy_engine_session_open_psd(runtime, psd.data, psd.size,
                                                  &error);
  CHECK(reopened != nullptr);
  patchy_engine_layer_projection reopened_layer{};
  CHECK(patchy_engine_session_layer_at(reopened, 0, &reopened_layer, &error) ==
        1);
  CHECK(reopened_layer.visible == 0);

  patchy_engine_session_destroy(reopened);
  patchy_engine_buffer_release(&psd);
  patchy_engine_session_destroy(session);
  patchy_engine_runtime_destroy(runtime);
}

void engine_host_protocol_authors_layers_and_document_geometry() {
  patchy_engine_error error{};
  auto *runtime = patchy_engine_runtime_create(
      PATCHY_ENGINE_HOST_PROTOCOL_VERSION, &error);
  CHECK(runtime != nullptr);
  auto *session = patchy_engine_session_create_rgba8(runtime, 4, 3, &error);
  CHECK(session != nullptr);

  const auto project = [&]() {
    patchy_engine_document_projection document{};
    document.struct_size = sizeof(document);
    CHECK(patchy_engine_session_document(session, &document, &error) == 1);
    return document;
  };
  const auto execute = [&](patchy_engine_command &command) {
    const auto before = project();
    command.struct_size = sizeof(command);
    command.protocol_version = PATCHY_ENGINE_HOST_PROTOCOL_VERSION;
    command.expected_state_id = before.state_id;
    command.expected_revision = before.revision;
    patchy_engine_event event{};
    CHECK(patchy_engine_session_execute(session, &command, &event, &error) ==
          1);
    return event;
  };
  const auto set_name = [](char *destination, std::uint32_t &size,
                           const char *name) {
    size = static_cast<std::uint32_t>(std::strlen(name));
    std::memcpy(destination, name, size);
  };

  auto document = project();
  CHECK(document.width == 4);
  CHECK(document.height == 3);
  CHECK(document.color_mode == PATCHY_ENGINE_COLOR_MODE_RGB);
  CHECK(document.bit_depth == PATCHY_ENGINE_BIT_DEPTH_UINT8);
  CHECK(document.channels == 4);
  CHECK(document.layer_count == 0);
  CHECK(document.dirty == 0);
  CHECK(document.can_undo == 0);

  patchy_engine_command add_base{};
  add_base.type = PATCHY_ENGINE_COMMAND_ADD_SOLID_LAYER;
  set_name(add_base.payload.add_solid_layer.name,
           add_base.payload.add_solid_layer.name_size, "Base");
  add_base.payload.add_solid_layer.red = 20;
  add_base.payload.add_solid_layer.green = 40;
  add_base.payload.add_solid_layer.blue = 60;
  add_base.payload.add_solid_layer.alpha = 255;
  const auto base_event = execute(add_base);
  CHECK(base_event.changed == 1);
  const auto base_id = base_event.affected_layer_id;
  CHECK(base_id != 0);

  patchy_engine_command add_upper{};
  add_upper.type = PATCHY_ENGINE_COMMAND_ADD_SOLID_LAYER;
  set_name(add_upper.payload.add_solid_layer.name,
           add_upper.payload.add_solid_layer.name_size, "Upper");
  add_upper.payload.add_solid_layer.red = 200;
  add_upper.payload.add_solid_layer.green = 100;
  add_upper.payload.add_solid_layer.blue = 50;
  add_upper.payload.add_solid_layer.alpha = 180;
  const auto upper_event = execute(add_upper);
  const auto upper_id = upper_event.affected_layer_id;
  CHECK(upper_id != 0);
  const auto stale_state_id = upper_event.state_id;

  patchy_engine_command opacity{};
  opacity.type = PATCHY_ENGINE_COMMAND_SET_LAYER_OPACITY;
  opacity.payload.set_layer_opacity = {upper_id, 0.75F};
  execute(opacity);

  patchy_engine_command stale_rename{};
  stale_rename.struct_size = sizeof(stale_rename);
  stale_rename.protocol_version = PATCHY_ENGINE_HOST_PROTOCOL_VERSION;
  stale_rename.type = PATCHY_ENGINE_COMMAND_RENAME_LAYER;
  stale_rename.expected_state_id = stale_state_id;
  stale_rename.expected_revision = upper_event.revision;
  stale_rename.payload.rename_layer.layer_id = upper_id;
  set_name(stale_rename.payload.rename_layer.name,
           stale_rename.payload.rename_layer.name_size, "Stale");
  patchy_engine_event ignored{};
  CHECK(patchy_engine_session_execute(session, &stale_rename, &ignored,
                                      &error) == 0);
  CHECK(error.code == PATCHY_ENGINE_ERROR_STALE_STATE);

  patchy_engine_command invalid_name{};
  invalid_name.struct_size = sizeof(invalid_name);
  invalid_name.protocol_version = PATCHY_ENGINE_HOST_PROTOCOL_VERSION;
  invalid_name.type = PATCHY_ENGINE_COMMAND_RENAME_LAYER;
  invalid_name.expected_state_id = project().state_id;
  invalid_name.expected_revision = project().revision;
  invalid_name.payload.rename_layer.layer_id = upper_id;
  invalid_name.payload.rename_layer.name_size = 2;
  invalid_name.payload.rename_layer.name[0] = static_cast<char>(0xC0);
  invalid_name.payload.rename_layer.name[1] = static_cast<char>(0xAF);
  CHECK(patchy_engine_session_execute(session, &invalid_name, &ignored,
                                      &error) == 0);
  CHECK(error.code == PATCHY_ENGINE_ERROR_INVALID_ARGUMENT);

  patchy_engine_command fill{};
  fill.type = PATCHY_ENGINE_COMMAND_SET_LAYER_FILL_OPACITY;
  fill.payload.set_layer_fill_opacity = {upper_id, 0.5F};
  execute(fill);

  patchy_engine_command blend{};
  blend.type = PATCHY_ENGINE_COMMAND_SET_LAYER_BLEND_MODE;
  blend.payload.set_layer_blend_mode = {
      upper_id, PATCHY_ENGINE_BLEND_MULTIPLY};
  execute(blend);

  patchy_engine_command rename{};
  rename.type = PATCHY_ENGINE_COMMAND_RENAME_LAYER;
  rename.payload.rename_layer.layer_id = upper_id;
  set_name(rename.payload.rename_layer.name,
           rename.payload.rename_layer.name_size, "Browser upper");
  execute(rename);

  patchy_engine_command locks{};
  locks.type = PATCHY_ENGINE_COMMAND_SET_LAYER_LOCKS;
  locks.payload.set_layer_locks = {upper_id,
                                   PATCHY_ENGINE_LAYER_LOCK_POSITION};
  execute(locks);

  patchy_engine_command clipping{};
  clipping.type = PATCHY_ENGINE_COMMAND_SET_LAYER_CLIPPING;
  clipping.payload.set_layer_clipping = {upper_id, 1};
  execute(clipping);

  patchy_engine_layer_projection upper{};
  CHECK(patchy_engine_session_layer_at(session, 1, &upper, &error) == 1);
  CHECK(upper.id == upper_id);
  CHECK(upper.name_size == std::strlen("Browser upper"));
  CHECK(std::string(upper.name, upper.name_size) == "Browser upper");
  CHECK(std::abs(upper.opacity - 0.75F) < 0.001F);
  CHECK(std::abs(upper.fill_opacity - 0.5F) < 0.001F);
  CHECK(upper.blend_mode == PATCHY_ENGINE_BLEND_MULTIPLY);
  CHECK(upper.lock_flags == PATCHY_ENGINE_LAYER_LOCK_POSITION);
  CHECK(upper.clipped == 1);
  CHECK(upper.bounds.width == 4);

  const auto before_visibility = project();
  CHECK(patchy_engine_session_set_layer_visibility(
            session, before_visibility.state_id, before_visibility.revision,
            upper_id, 0, &ignored, &error) == 1);
  CHECK(patchy_engine_session_set_layer_visibility(
            session, before_visibility.state_id, before_visibility.revision,
            upper_id, 1, &ignored, &error) == 0);
  CHECK(error.code == PATCHY_ENGINE_ERROR_STALE_STATE);
  const auto hidden = project();
  CHECK(patchy_engine_session_set_layer_visibility(
            session, hidden.state_id, hidden.revision, upper_id, 1, &ignored,
            &error) == 1);

  patchy_engine_command add_group{};
  add_group.type = PATCHY_ENGINE_COMMAND_ADD_GROUP;
  set_name(add_group.payload.add_group.name,
           add_group.payload.add_group.name_size, "Browser group");
  const auto group = execute(add_group);
  const auto before_move = project();
  CHECK(patchy_engine_session_move_layer(
            session, before_move.state_id, before_move.revision, base_id,
            group.affected_layer_id, PATCHY_ENGINE_DROP_ON_ITEM, 1, &ignored,
            &error) == 1);
  patchy_engine_command move_upper{};
  move_upper.type = PATCHY_ENGINE_COMMAND_MOVE_LAYER;
  move_upper.payload.move_layer = {upper_id, group.affected_layer_id,
                                   PATCHY_ENGINE_DROP_ON_ITEM, 1};
  execute(move_upper);
  patchy_engine_layer_projection grouped_base{};
  patchy_engine_layer_projection grouped_upper{};
  CHECK(patchy_engine_session_layer_at(session, 1, &grouped_base, &error) ==
        1);
  CHECK(patchy_engine_session_layer_at(session, 2, &grouped_upper, &error) ==
        1);
  CHECK(grouped_base.parent_id == group.affected_layer_id);
  CHECK(grouped_upper.parent_id == group.affected_layer_id);
  patchy_engine_command ungroup{};
  ungroup.type = PATCHY_ENGINE_COMMAND_UNGROUP;
  ungroup.payload.ungroup.group_id = group.affected_layer_id;
  execute(ungroup);
  CHECK(project().layer_count == 2);

  const auto before_atomic_group = project();
  patchy_engine_event atomic_group{};
  constexpr char atomic_group_name[] = "Atomic group";
  CHECK(patchy_engine_session_group_layer(
            session, before_atomic_group.state_id,
            before_atomic_group.revision, base_id, atomic_group_name,
            sizeof(atomic_group_name) - 1, &atomic_group, &error) == 1);
  CHECK(atomic_group.changed == 1);
  CHECK(atomic_group.affected_layer_id != 0);
  CHECK(project().layer_count == 3);
  patchy_engine_layer_projection atomic_grouped_base{};
  bool found_atomic_grouped_base = false;
  for (std::size_t index = 0; index < project().layer_count; ++index) {
    patchy_engine_layer_projection projected{};
    CHECK(patchy_engine_session_layer_at(session, index, &projected,
                                         &error) == 1);
    if (projected.id == base_id) {
      atomic_grouped_base = projected;
      found_atomic_grouped_base = true;
      break;
    }
  }
  CHECK(found_atomic_grouped_base);
  CHECK(atomic_grouped_base.parent_id == atomic_group.affected_layer_id);
  CHECK(patchy_engine_session_undo(session, &ignored, &error) == 1);
  CHECK(project().layer_count == 2);

  patchy_engine_command add_temporary{};
  add_temporary.type = PATCHY_ENGINE_COMMAND_ADD_SOLID_LAYER;
  set_name(add_temporary.payload.add_solid_layer.name,
           add_temporary.payload.add_solid_layer.name_size, "Temporary");
  add_temporary.payload.add_solid_layer.alpha = 255;
  const auto temporary = execute(add_temporary);
  patchy_engine_command remove{};
  remove.type = PATCHY_ENGINE_COMMAND_REMOVE_LAYER;
  remove.payload.remove_layer.layer_id = temporary.affected_layer_id;
  execute(remove);

  patchy_engine_command resize{};
  resize.type = PATCHY_ENGINE_COMMAND_RESIZE_IMAGE;
  resize.payload.resize_image = {8, 6};
  execute(resize);
  patchy_engine_command canvas{};
  canvas.type = PATCHY_ENGINE_COMMAND_RESIZE_CANVAS;
  canvas.payload.resize_canvas.width = 10;
  canvas.payload.resize_canvas.height = 8;
  canvas.payload.resize_canvas.anchor = PATCHY_ENGINE_ANCHOR_CENTER;
  canvas.payload.resize_canvas.alpha = 255;
  execute(canvas);
  patchy_engine_command rotate{};
  rotate.type = PATCHY_ENGINE_COMMAND_ROTATE_CANVAS;
  rotate.payload.rotate_canvas.clockwise_degrees = 90.0;
  rotate.payload.rotate_canvas.alpha = 255;
  execute(rotate);
  CHECK(project().width == 8);
  CHECK(project().height == 10);
  patchy_engine_command crop{};
  crop.type = PATCHY_ENGINE_COMMAND_CROP_DOCUMENT;
  crop.payload.crop_document.crop = {1, 2, 6, 7};
  crop.payload.crop_document.alpha = 255;
  execute(crop);
  document = project();
  CHECK(document.width == 6);
  CHECK(document.height == 7);
  CHECK(document.layer_count == 2);
  CHECK(document.dirty == 1);
  CHECK(document.can_undo == 1);

  patchy_engine_event event{};
  CHECK(patchy_engine_session_undo(session, &event, &error) == 1);
  CHECK(project().width == 8);
  CHECK(patchy_engine_session_redo(session, &event, &error) == 1);
  CHECK(project().width == 6);

  patchy_engine_buffer render{};
  CHECK(patchy_engine_session_render(session, {0, 0, 6, 7}, &render, &event,
                                     &error) == 1);
  CHECK(render.size == 6U * 7U * 4U);
  patchy_engine_buffer_release(&render);

  patchy_engine_buffer psd{};
  CHECK(patchy_engine_session_save_psd(session, &psd, &event, &error) == 1);
  CHECK(psd.size > 0);
  const auto saved_state_id = event.state_id;
  CHECK(patchy_engine_session_mark_saved(session, saved_state_id - 1, &event,
                                         &error) == 0);
  CHECK(error.code == PATCHY_ENGINE_ERROR_STALE_STATE);
  CHECK(project().dirty == 1);
  CHECK(patchy_engine_session_mark_saved(session, saved_state_id, &event,
                                         &error) == 1);
  CHECK(event.dirty == 0);
  auto *reopened = patchy_engine_session_open_psd(runtime, psd.data, psd.size,
                                                  &error);
  CHECK(reopened != nullptr);
  patchy_engine_document_projection reopened_document{};
  reopened_document.struct_size = sizeof(reopened_document);
  CHECK(patchy_engine_session_document(reopened, &reopened_document, &error) ==
        1);
  CHECK(reopened_document.width == 6);
  CHECK(reopened_document.height == 7);
  CHECK(reopened_document.layer_count == 2);
  patchy_engine_layer_projection reopened_upper{};
  CHECK(patchy_engine_session_layer_at(reopened, 1, &reopened_upper, &error) ==
        1);
  CHECK(std::string(reopened_upper.name, reopened_upper.name_size) ==
        "Browser upper");
  CHECK(reopened_upper.clipped == 1);

  patchy_engine_session_destroy(reopened);
  patchy_engine_buffer_release(&psd);
  patchy_engine_session_destroy(session);
  patchy_engine_runtime_destroy(runtime);
}

void engine_host_protocol_authors_pixels_channels_and_selection() {
  patchy_engine_error error{};
  auto *runtime = patchy_engine_runtime_create(
      PATCHY_ENGINE_HOST_PROTOCOL_VERSION, &error);
  CHECK(runtime != nullptr);
  auto *session = patchy_engine_session_create_rgba8(runtime, 5, 4, &error);
  CHECK(session != nullptr);

  const auto project = [&]() {
    patchy_engine_document_projection document{};
    document.struct_size = sizeof(document);
    CHECK(patchy_engine_session_document(session, &document, &error) == 1);
    return document;
  };
  const auto execute = [&](patchy_engine_command &command) {
    const auto before = project();
    command.struct_size = sizeof(command);
    command.protocol_version = PATCHY_ENGINE_HOST_PROTOCOL_VERSION;
    command.expected_state_id = before.state_id;
    command.expected_revision = before.revision;
    patchy_engine_event event{};
    CHECK(patchy_engine_session_execute(session, &command, &event, &error) ==
          1);
    return event;
  };

  std::vector<std::uint8_t> pixels(2U * 2U * 4U, 0U);
  for (std::size_t index = 0; index < pixels.size(); index += 4U) {
    pixels[index] = 220;
    pixels[index + 1U] = 40;
    pixels[index + 2U] = 30;
    pixels[index + 3U] = 255;
  }
  const auto before_add = project();
  const std::string pixel_name = "Uploaded pixels";
  patchy_engine_pixel_layer_input add{};
  add.struct_size = sizeof(add);
  add.expected_state_id = before_add.state_id;
  add.expected_revision = before_add.revision;
  add.bounds = {1, 1, 2, 2};
  add.width = 2;
  add.height = 2;
  add.rgba = pixels.data();
  add.rgba_size = pixels.size();
  add.name = pixel_name.data();
  add.name_size = pixel_name.size();
  patchy_engine_event event{};
  CHECK(patchy_engine_session_add_rgba8_layer(session, &add, &event, &error) ==
        1);
  CHECK(event.changed == 1);
  const auto layer_id = event.affected_layer_id;
  CHECK(layer_id != 0);
  patchy_engine_layer_projection layer{};
  CHECK(patchy_engine_session_layer_at(session, 0, &layer, &error) == 1);
  CHECK(layer.id == layer_id);
  CHECK(layer.bounds.x == 1);
  CHECK(layer.bounds.y == 1);
  CHECK(layer.bounds.width == 2);
  CHECK(project().revision == before_add.revision + 1U);

  pixels[0] = 10;
  pixels[1] = 200;
  const auto before_replace = project();
  patchy_engine_pixel_layer_input replace = add;
  replace.expected_state_id = before_replace.state_id;
  replace.expected_revision = before_replace.revision;
  replace.layer_id = layer_id;
  CHECK(patchy_engine_session_replace_rgba8_layer(session, &replace, &event,
                                                  &error) == 1);
  CHECK(event.changed == 1);
  patchy_engine_buffer replaced_render{};
  CHECK(patchy_engine_session_render(session, {1, 1, 1, 1},
                                     &replaced_render, &event, &error) == 1);
  CHECK(replaced_render.size == 4);
  CHECK(replaced_render.data[0] == 10);
  CHECK(replaced_render.data[1] == 200);
  patchy_engine_buffer_release(&replaced_render);

  patchy_engine_command select_all{};
  select_all.type = PATCHY_ENGINE_COMMAND_SELECT_ALL;
  const auto before_select_all = project();
  const auto selected_event = execute(select_all);
  CHECK(selected_event.state_id == event.state_id);
  CHECK(selected_event.state_id == before_select_all.state_id);
  CHECK(selected_event.revision == before_select_all.revision + 1U);
  patchy_engine_command stale_after_selection{};
  stale_after_selection.struct_size = sizeof(stale_after_selection);
  stale_after_selection.protocol_version = PATCHY_ENGINE_HOST_PROTOCOL_VERSION;
  stale_after_selection.type = PATCHY_ENGINE_COMMAND_SET_LAYER_VISIBILITY;
  stale_after_selection.expected_state_id = before_select_all.state_id;
  stale_after_selection.expected_revision = before_select_all.revision;
  stale_after_selection.payload.set_layer_visibility = {layer_id, 0};
  patchy_engine_event stale_event{};
  CHECK(patchy_engine_session_execute(session, &stale_after_selection,
                                      &stale_event, &error) == 0);
  CHECK(error.code == PATCHY_ENGINE_ERROR_STALE_STATE);
  patchy_engine_selection_projection selection{};
  selection.struct_size = sizeof(selection);
  CHECK(patchy_engine_session_selection(session, &selection, &error) == 1);
  CHECK(selection.empty == 0);
  CHECK(selection.selection_rect_count == 1);
  patchy_engine_rect selection_rect{};
  CHECK(patchy_engine_session_selection_rect_at(
            session, 0, &selection_rect, &error) == 1);
  CHECK(selection_rect.width == 5);
  CHECK(selection_rect.height == 4);

  std::vector<std::uint8_t> channel_pixels(20U, 0U);
  channel_pixels[6] = 128;
  channel_pixels[7] = 255;
  const std::string channel_name = "Browser alpha";
  const auto before_channel = project();
  patchy_engine_alpha_channel_input channel_input{};
  channel_input.struct_size = sizeof(channel_input);
  channel_input.expected_state_id = before_channel.state_id;
  channel_input.expected_revision = before_channel.revision;
  channel_input.gray = channel_pixels.data();
  channel_input.gray_size = channel_pixels.size();
  channel_input.name = channel_name.data();
  channel_input.name_size = channel_name.size();
  CHECK(patchy_engine_session_add_alpha_channel(
            session, &channel_input, &event, &error) == 1);
  std::size_t channel_count = 0;
  CHECK(patchy_engine_session_channel_count(session, &channel_count, &error) ==
        1);
  CHECK(channel_count == 1);
  patchy_engine_channel_projection channel{};
  CHECK(patchy_engine_session_channel_at(session, 0, &channel, &error) == 1);
  CHECK(std::string(channel.name, channel.name_size) == channel_name);
  const auto channel_id = channel.id;
  patchy_engine_buffer exported_channel{};
  CHECK(patchy_engine_session_channel_pixels(
            session, channel_id, &exported_channel, &error) == 1);
  CHECK(exported_channel.size == channel_pixels.size());
  CHECK(exported_channel.data[6] == 128);
  patchy_engine_buffer_release(&exported_channel);

  patchy_engine_command select_channel{};
  select_channel.type = PATCHY_ENGINE_COMMAND_SELECT_CHANNEL;
  select_channel.payload.select_channel.channel_id = channel_id;
  execute(select_channel);
  selection = {};
  selection.struct_size = sizeof(selection);
  CHECK(patchy_engine_session_selection(session, &selection, &error) == 1);
  CHECK(selection.has_mask == 1);
  CHECK(selection.selection_rect_count == 1);
  patchy_engine_buffer selection_mask{};
  CHECK(patchy_engine_session_selection_mask(session, &selection_mask,
                                              &error) == 1);
  CHECK(selection_mask.size == channel_pixels.size());
  CHECK(selection_mask.data[6] == 128);
  patchy_engine_buffer_release(&selection_mask);

  patchy_engine_command rename_channel{};
  rename_channel.type = PATCHY_ENGINE_COMMAND_RENAME_CHANNEL;
  rename_channel.payload.rename_channel.channel_id = channel_id;
  const std::string renamed = "Mask from browser";
  rename_channel.payload.rename_channel.name_size =
      static_cast<std::uint32_t>(renamed.size());
  std::memcpy(rename_channel.payload.rename_channel.name, renamed.data(),
              renamed.size());
  execute(rename_channel);
  patchy_engine_command invert_channel{};
  invert_channel.type = PATCHY_ENGINE_COMMAND_INVERT_CHANNEL;
  invert_channel.payload.invert_channel.channel_id = channel_id;
  execute(invert_channel);
  patchy_engine_buffer inverted{};
  CHECK(patchy_engine_session_channel_pixels(session, channel_id, &inverted,
                                              &error) == 1);
  CHECK(inverted.data[6] == 127);
  CHECK(inverted.data[7] == 0);
  patchy_engine_buffer_release(&inverted);

  std::fill(channel_pixels.begin(), channel_pixels.end(), 64U);
  const auto before_second_channel = project();
  channel_input.expected_state_id = before_second_channel.state_id;
  channel_input.expected_revision = before_second_channel.revision;
  channel_input.gray = channel_pixels.data();
  channel_input.name = "Second alpha";
  channel_input.name_size = std::strlen(channel_input.name);
  CHECK(patchy_engine_session_add_alpha_channel(
            session, &channel_input, &event, &error) == 1);
  CHECK(patchy_engine_session_channel_count(session, &channel_count, &error) ==
        1);
  CHECK(channel_count == 2);
  patchy_engine_channel_projection second_channel{};
  CHECK(patchy_engine_session_channel_at(session, 1, &second_channel, &error) ==
        1);
  patchy_engine_command move_channel{};
  move_channel.type = PATCHY_ENGINE_COMMAND_MOVE_CHANNEL;
  move_channel.payload.move_channel = {second_channel.id, 0};
  execute(move_channel);
  CHECK(patchy_engine_session_channel_at(session, 0, &second_channel, &error) ==
        1);
  CHECK(std::string(second_channel.name, second_channel.name_size) ==
        "Second alpha");

  const patchy_engine_path_anchor path_anchors[] = {
      {1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0},
      {4.0, 1.0, 4.0, 1.0, 4.0, 1.0, 0},
      {4.0, 3.0, 4.0, 3.0, 4.0, 3.0, 0},
      {1.0, 3.0, 1.0, 3.0, 1.0, 3.0, 0},
  };
  const patchy_engine_path_subpath_input path_subpath{
      0, 4, 0, PATCHY_ENGINE_PATH_ADD, 1};
  const patchy_engine_path_input path_input{
      &path_subpath, 1, path_anchors, 4};
  const std::string path_name = "Browser path";
  const auto before_path = project();
  patchy_engine_document_path_input add_path{};
  add_path.struct_size = sizeof(add_path);
  add_path.expected_state_id = before_path.state_id;
  add_path.expected_revision = before_path.revision;
  add_path.name = path_name.data();
  add_path.name_size = path_name.size();
  add_path.kind = PATCHY_ENGINE_PATH_SAVED;
  add_path.path = path_input;
  CHECK(patchy_engine_session_add_document_path(session, &add_path, &event,
                                                &error) == 1);
  const auto path_id = event.affected_layer_id;
  CHECK(path_id != 0);
  std::size_t path_count = 0;
  CHECK(patchy_engine_session_path_count(session, &path_count, &error) == 1);
  CHECK(path_count == 1);
  patchy_engine_document_path_projection path{};
  CHECK(patchy_engine_session_path_at(session, 0, &path, &error) == 1);
  CHECK(path.id == path_id);
  CHECK(path.subpath_count == 1);
  CHECK(path.anchor_count == 4);
  patchy_engine_path_subpath_projection projected_subpath{};
  CHECK(patchy_engine_session_path_subpath_at(
            session, path_id, 0, &projected_subpath, &error) == 1);
  CHECK(projected_subpath.anchor_count == 4);
  patchy_engine_path_anchor projected_anchor{};
  CHECK(patchy_engine_session_path_anchor_at(
            session, path_id, 0, 2, &projected_anchor, &error) == 1);
  CHECK(projected_anchor.anchor_x == 4.0);
  CHECK(projected_anchor.anchor_y == 3.0);

  patchy_engine_command rename_path{};
  rename_path.type = PATCHY_ENGINE_COMMAND_RENAME_DOCUMENT_PATH;
  rename_path.payload.rename_document_path.path_id = path_id;
  const std::string renamed_path = "Clipping outline";
  rename_path.payload.rename_document_path.name_size =
      static_cast<std::uint32_t>(renamed_path.size());
  std::memcpy(rename_path.payload.rename_document_path.name,
              renamed_path.data(), renamed_path.size());
  execute(rename_path);
  patchy_engine_command clipping_path{};
  clipping_path.type = PATCHY_ENGINE_COMMAND_SET_CLIPPING_PATH;
  clipping_path.payload.set_clipping_path = {path_id, 1};
  execute(clipping_path);
  CHECK(patchy_engine_session_path_at(session, 0, &path, &error) == 1);
  CHECK(path.clipping == 1);

  const std::string second_path_name = "Temporary path";
  const auto before_second_path = project();
  add_path.expected_state_id = before_second_path.state_id;
  add_path.expected_revision = before_second_path.revision;
  add_path.name = second_path_name.data();
  add_path.name_size = second_path_name.size();
  add_path.clipping = 0;
  CHECK(patchy_engine_session_add_document_path(session, &add_path, &event,
                                                &error) == 1);
  const auto second_path_id = event.affected_layer_id;
  patchy_engine_command move_path{};
  move_path.type = PATCHY_ENGINE_COMMAND_MOVE_DOCUMENT_PATH;
  move_path.payload.move_document_path = {second_path_id, 0};
  execute(move_path);
  CHECK(patchy_engine_session_path_at(session, 0, &path, &error) == 1);
  CHECK(path.id == second_path_id);
  patchy_engine_command remove_path{};
  remove_path.type = PATCHY_ENGINE_COMMAND_REMOVE_DOCUMENT_PATH;
  remove_path.payload.remove_document_path.path_id = second_path_id;
  execute(remove_path);
  CHECK(patchy_engine_session_path_count(session, &path_count, &error) == 1);
  CHECK(path_count == 1);

  patchy_engine_command select_path{};
  select_path.type = PATCHY_ENGINE_COMMAND_SELECT_DOCUMENT_PATH;
  select_path.payload.select_document_path.path_id = path_id;
  select_path.payload.select_document_path.combine =
      PATCHY_ENGINE_SELECTION_REPLACE;
  select_path.payload.select_document_path.antialias = 1;
  execute(select_path);
  selection = {};
  selection.struct_size = sizeof(selection);
  CHECK(patchy_engine_session_selection(session, &selection, &error) == 1);
  CHECK(selection.empty == 0);

  const auto before_shape = project();
  const std::string shape_name = "Browser vector";
  patchy_engine_vector_shape_input shape{};
  shape.struct_size = sizeof(shape);
  shape.expected_state_id = before_shape.state_id;
  shape.expected_revision = before_shape.revision;
  shape.name = shape_name.data();
  shape.name_size = shape_name.size();
  shape.path = path_input;
  shape.fill_red = 30;
  shape.fill_green = 120;
  shape.fill_blue = 220;
  shape.stroke_enabled = 1;
  shape.stroke_red = 250;
  shape.stroke_green = 240;
  shape.stroke_blue = 20;
  shape.stroke_width = 1.5;
  CHECK(patchy_engine_session_add_vector_shape(session, &shape, &event,
                                               &error) == 1);
  CHECK(event.affected_layer_id != 0);
  CHECK(project().layer_count == 2);

  patchy_engine_command clear_selection{};
  clear_selection.type = PATCHY_ENGINE_COMMAND_CLEAR_SELECTION;
  execute(clear_selection);
  selection = {};
  selection.struct_size = sizeof(selection);
  CHECK(patchy_engine_session_selection(session, &selection, &error) == 1);
  CHECK(selection.empty == 1);
  CHECK(patchy_engine_session_undo(session, &event, &error) == 1);
  selection = {};
  selection.struct_size = sizeof(selection);
  CHECK(patchy_engine_session_selection(session, &selection, &error) == 1);
  CHECK(selection.empty == 0);

  patchy_engine_buffer pre_save_render{};
  CHECK(patchy_engine_session_render(session, {0, 0, 5, 4},
                                     &pre_save_render, &event, &error) == 1);
  patchy_engine_buffer psd{};
  CHECK(patchy_engine_session_save_psd(session, &psd, &event, &error) == 1);
  auto *reopened = patchy_engine_session_open_psd(runtime, psd.data, psd.size,
                                                  &error);
  CHECK(reopened != nullptr);
  CHECK(patchy_engine_session_channel_count(reopened, &channel_count, &error) ==
        1);
  CHECK(channel_count == 2);
  CHECK(patchy_engine_session_path_count(reopened, &path_count, &error) == 1);
  CHECK(path_count == 1);
  CHECK(patchy_engine_session_path_at(reopened, 0, &path, &error) == 1);
  CHECK(std::string(path.name, path.name_size) == renamed_path);
  CHECK(path.clipping == 1);
  patchy_engine_layer_projection reopened_layer{};
  CHECK(patchy_engine_session_layer_at(reopened, 0, &reopened_layer, &error) ==
        1);
  CHECK(reopened_layer.bounds.x == 1);
  std::size_t reopened_layer_count = 0;
  CHECK(patchy_engine_session_layer_count(reopened, &reopened_layer_count,
                                          &error) == 1);
  CHECK(reopened_layer_count == 2);
  patchy_engine_buffer reopened_render{};
  CHECK(patchy_engine_session_render(reopened, {0, 0, 5, 4},
                                     &reopened_render, &event, &error) == 1);
  CHECK(reopened_render.size == pre_save_render.size);
  CHECK(std::equal(reopened_render.data,
                   reopened_render.data + reopened_render.size,
                   pre_save_render.data));

  patchy_engine_buffer_release(&reopened_render);
  patchy_engine_buffer_release(&pre_save_render);
  patchy_engine_session_destroy(reopened);
  patchy_engine_buffer_release(&psd);
  patchy_engine_session_destroy(session);
  patchy_engine_runtime_destroy(runtime);
}

void engine_host_protocol_runs_mask_filter_async_lifecycle() {
  patchy_engine_error error{};
  auto *runtime = patchy_engine_runtime_create(
      PATCHY_ENGINE_HOST_PROTOCOL_VERSION, &error);
  CHECK(runtime != nullptr);
  auto *session = patchy_engine_session_create_rgba8(runtime, 2, 2, &error);
  CHECK(session != nullptr);
  const auto project = [&]() {
    patchy_engine_document_projection document{};
    document.struct_size = sizeof(document);
    CHECK(patchy_engine_session_document(session, &document, &error) == 1);
    return document;
  };

  const std::array<std::uint8_t, 16> pixels{
      20, 40, 60, 255, 20, 40, 60, 255,
      20, 40, 60, 255, 20, 40, 60, 255};
  const auto initial = project();
  patchy_engine_pixel_layer_input add{};
  add.struct_size = sizeof(add);
  add.expected_state_id = initial.state_id;
  add.expected_revision = initial.revision;
  add.bounds = {0, 0, 2, 2};
  add.width = 2;
  add.height = 2;
  add.rgba = pixels.data();
  add.rgba_size = pixels.size();
  add.name = "Async pixels";
  add.name_size = std::strlen(add.name);
  patchy_engine_event event{};
  CHECK(patchy_engine_session_add_rgba8_layer(session, &add, &event, &error) ==
        1);
  const auto layer_id = event.affected_layer_id;

  const std::array<std::uint8_t, 4> mask_pixels{255, 0, 128, 255};
  const auto before_mask = project();
  patchy_engine_layer_mask_input mask{};
  mask.struct_size = sizeof(mask);
  mask.expected_state_id = before_mask.state_id;
  mask.expected_revision = before_mask.revision;
  mask.layer_id = layer_id;
  mask.bounds = {0, 0, 2, 2};
  mask.width = 2;
  mask.height = 2;
  mask.gray = mask_pixels.data();
  mask.gray_size = mask_pixels.size();
  mask.default_color = 255;
  mask.has_mask = 1;
  CHECK(patchy_engine_session_set_layer_mask(session, &mask, &event, &error) ==
        1);

  patchy_engine_layer_mask_projection projected_mask{};
  projected_mask.struct_size = sizeof(projected_mask);
  CHECK(patchy_engine_session_layer_mask(session, layer_id, &projected_mask,
                                         &error) == 1);
  CHECK(projected_mask.has_mask == 1);
  CHECK(projected_mask.bounds.width == 2);
  CHECK(projected_mask.default_color == 255);
  CHECK(projected_mask.linked == 0);
  patchy_engine_buffer projected_mask_pixels{};
  CHECK(patchy_engine_session_layer_mask_pixels(
            session, layer_id, &projected_mask_pixels, &error) == 1);
  CHECK(projected_mask_pixels.size == mask_pixels.size());
  CHECK(projected_mask_pixels.data[1] == 0);
  patchy_engine_buffer_release(&projected_mask_pixels);

  const auto before_selection = project();
  const std::array<patchy_engine_rect, 1> selection_rects{{{0, 0, 1, 2}}};
  patchy_engine_selection_input selection_input{};
  selection_input.struct_size = sizeof(selection_input);
  selection_input.expected_state_id = before_selection.state_id;
  selection_input.expected_revision = before_selection.revision;
  selection_input.rects = selection_rects.data();
  selection_input.rect_count = selection_rects.size();
  CHECK(patchy_engine_session_set_selection(
            session, &selection_input, &event, &error) == 1);
  patchy_engine_selection_projection projected_selection{};
  projected_selection.struct_size = sizeof(projected_selection);
  CHECK(patchy_engine_session_selection(
            session, &projected_selection, &error) == 1);
  CHECK(projected_selection.selection_rect_count == 1);
  patchy_engine_rect projected_selection_rect{};
  CHECK(patchy_engine_session_selection_rect_at(
            session, 0, &projected_selection_rect, &error) == 1);
  CHECK(projected_selection_rect.width == 1);
  CHECK(projected_selection_rect.height == 2);

  struct FilterProgressState {
    int calls{0};
    int completed{0};
  } filter_state;
  const auto filter_callback = [](std::int32_t completed, std::int32_t,
                                  std::uint32_t, void *user_data) -> int {
    auto &state = *static_cast<FilterProgressState *>(user_data);
    ++state.calls;
    state.completed = std::max(state.completed, static_cast<int>(completed));
    return 1;
  };
  const auto before_filter = project();
  patchy_engine_filter_input filter{};
  filter.struct_size = sizeof(filter);
  filter.expected_state_id = before_filter.state_id;
  filter.expected_revision = before_filter.revision;
  filter.layer_id = layer_id;
  filter.filter_id = "patchy.filters.invert";
  filter.filter_id_size = std::strlen(filter.filter_id);
  filter.selection = selection_rects.data();
  filter.selection_count = selection_rects.size();
  CHECK(patchy_engine_session_apply_filter(
            session, &filter, filter_callback, &filter_state, nullptr, &event,
            &error) == 1);
  CHECK(filter_state.calls > 0);

  struct RenderProgressState {
    int calls{0};
    int completed{0};
  } render_state;
  const auto render_callback = [](std::int32_t completed, std::int32_t,
                                  void *user_data) -> int {
    auto &state = *static_cast<RenderProgressState *>(user_data);
    ++state.calls;
    state.completed = std::max(state.completed, static_cast<int>(completed));
    return 1;
  };
  patchy_engine_buffer rendered{};
  CHECK(patchy_engine_session_render_with_progress(
            session, {0, 0, 2, 2}, render_callback, &render_state, nullptr,
            &rendered, &event, &error) == 1);
  CHECK(render_state.calls > 0);
  CHECK(rendered.size == 16);
  CHECK(rendered.data[0] == 235);
  CHECK(rendered.data[1] == 215);
  CHECK(rendered.data[2] == 195);
  CHECK(rendered.data[3] == 255);
  CHECK(rendered.data[7] == 0);

  auto *cancelled = patchy_engine_cancellation_create(&error);
  CHECK(cancelled != nullptr);
  patchy_engine_cancellation_cancel(cancelled);
  patchy_engine_buffer cancelled_output{};
  CHECK(patchy_engine_session_render_with_progress(
            session, {0, 0, 2, 2}, render_callback, &render_state, cancelled,
            &cancelled_output, &event, &error) == 0);
  CHECK(error.code == PATCHY_ENGINE_ERROR_CANCELLED);
  CHECK(cancelled_output.data == nullptr);
  CHECK(patchy_engine_session_save_psd_with_progress(
            session, nullptr, nullptr, cancelled, &cancelled_output, &event,
            &error) == 0);
  CHECK(error.code == PATCHY_ENGINE_ERROR_CANCELLED);
  const auto before_cancelled_filter = project();
  filter.expected_state_id = before_cancelled_filter.state_id;
  filter.expected_revision = before_cancelled_filter.revision;
  CHECK(patchy_engine_session_apply_filter(
            session, &filter, filter_callback, &filter_state, cancelled, &event,
            &error) == 0);
  CHECK(error.code == PATCHY_ENGINE_ERROR_CANCELLED);
  CHECK(project().state_id == before_cancelled_filter.state_id);
  patchy_engine_cancellation_destroy(cancelled);

  std::size_t event_count = 0;
  std::uint64_t dropped = 0;
  CHECK(patchy_engine_session_event_count(session, &event_count, &dropped,
                                          &error) == 1);
  CHECK(event_count == 4);
  CHECK(dropped == 0);
  std::size_t selection_events = 0;
  for (std::size_t index = 0; index < event_count; ++index) {
    patchy_engine_event queued{};
    CHECK(patchy_engine_session_pop_event(session, &queued, &error) == 1);
    CHECK(queued.kind == PATCHY_ENGINE_EVENT_COMMAND_APPLIED ||
          queued.kind == PATCHY_ENGINE_EVENT_SELECTION_CHANGED);
    selection_events +=
        queued.kind == PATCHY_ENGINE_EVENT_SELECTION_CHANGED ? 1U : 0U;
    CHECK(queued.state_id != 0);
  }
  CHECK(selection_events == 1);

  struct SaveProgressState {
    int calls{0};
    std::uint32_t phase{0};
    std::uint64_t bytes{0};
  } save_state;
  const auto save_callback = [](std::uint32_t phase, std::uint64_t bytes,
                                void *user_data) -> int {
    auto &state = *static_cast<SaveProgressState *>(user_data);
    CHECK(phase >= state.phase);
    if (phase == state.phase) {
      CHECK(bytes >= state.bytes);
    }
    ++state.calls;
    state.phase = phase;
    state.bytes = bytes;
    return 1;
  };
  patchy_engine_buffer psd{};
  CHECK(patchy_engine_session_save_psd_with_progress(
            session, save_callback, &save_state, nullptr, &psd, &event,
            &error) == 1);
  CHECK(save_state.calls > 0);
  auto *reopened = patchy_engine_session_open_psd(runtime, psd.data, psd.size,
                                                  &error);
  CHECK(reopened != nullptr);
  patchy_engine_layer_mask_projection reopened_mask{};
  reopened_mask.struct_size = sizeof(reopened_mask);
  CHECK(patchy_engine_session_layer_mask(reopened, layer_id, &reopened_mask,
                                         &error) == 1);
  CHECK(reopened_mask.has_mask == 1);
  CHECK(reopened_mask.bounds.width == 2);
  CHECK(reopened_mask.bounds.height == 2);
  CHECK(reopened_mask.default_color == 255);
  patchy_engine_buffer reopened_render{};
  CHECK(patchy_engine_session_render(reopened, {0, 0, 2, 2}, &reopened_render,
                                     &event, &error) == 1);
  CHECK(reopened_render.size == rendered.size);
  CHECK(std::equal(reopened_render.data,
                   reopened_render.data + reopened_render.size,
                   rendered.data));

  patchy_engine_buffer_release(&reopened_render);
  patchy_engine_session_destroy(reopened);
  patchy_engine_buffer_release(&psd);
  patchy_engine_buffer_release(&rendered);
  patchy_engine_session_destroy(session);
  patchy_engine_runtime_destroy(runtime);
}

void engine_host_protocol_authors_text_and_smart_objects() {
  patchy_engine_error error{};
  auto *runtime = patchy_engine_runtime_create(
      PATCHY_ENGINE_HOST_PROTOCOL_VERSION, &error);
  CHECK(runtime != nullptr);
  auto *session = patchy_engine_session_create_rgba8(runtime, 4, 3, &error);
  CHECK(session != nullptr);
  const auto project = [&]() {
    patchy_engine_document_projection document{};
    document.struct_size = sizeof(document);
    CHECK(patchy_engine_session_document(session, &document, &error) == 1);
    return document;
  };
  const std::array<std::uint8_t, 16> pixels{
      200, 40, 20, 255, 200, 40, 20, 255,
      200, 40, 20, 255, 200, 40, 20, 255};
  patchy_engine_event event{};

  const auto before_text = project();
  patchy_engine_text_layer_input text{};
  text.struct_size = sizeof(text);
  text.expected_state_id = before_text.state_id;
  text.expected_revision = before_text.revision;
  text.bounds = {0, 0, 2, 2};
  text.width = 2;
  text.height = 2;
  text.rgba = pixels.data();
  text.rgba_size = pixels.size();
  text.name = "Browser text";
  text.name_size = std::strlen(text.name);
  text.text = "Hello browser";
  text.text_size = std::strlen(text.text);
  text.font = "Inter";
  text.font_size = std::strlen(text.font);
  text.size_pixels = 24.0;
  text.red = 12;
  text.green = 34;
  text.blue = 56;
  text.bold = 1;
  text.box_text = 1;
  CHECK(patchy_engine_session_add_text_layer(session, &text, &event, &error) ==
        1);
  const auto text_id = event.affected_layer_id;
  patchy_engine_text_projection projected_text{};
  projected_text.struct_size = sizeof(projected_text);
  CHECK(patchy_engine_session_text(session, text_id, &projected_text, &error) ==
        1);
  CHECK(std::string(projected_text.text, projected_text.text_size) ==
        "Hello browser");
  CHECK(std::string(projected_text.font, projected_text.font_size) == "Inter");
  CHECK(projected_text.size_pixels == 24.0);
  CHECK(projected_text.red == 12);
  CHECK(projected_text.bold == 1);
  patchy_engine_buffer text_pixels{};
  CHECK(patchy_engine_session_layer_rgba8_pixels(
            session, text_id, &text_pixels, &error) == 1);
  CHECK(text_pixels.size == pixels.size());
  CHECK(text_pixels.data[0] == 200);
  patchy_engine_buffer_release(&text_pixels);

  const auto before_text_update = project();
  text.expected_state_id = before_text_update.state_id;
  text.expected_revision = before_text_update.revision;
  text.bounds = {1, 1, 2, 2};
  text.name = "Edited text";
  text.name_size = std::strlen(text.name);
  text.text = "Edited browser text";
  text.text_size = std::strlen(text.text);
  text.font = "Arial";
  text.font_size = std::strlen(text.font);
  text.size_pixels = 30.0;
  text.red = 90;
  text.green = 80;
  text.blue = 70;
  text.bold = 0;
  text.italic = 1;
  CHECK(patchy_engine_session_update_text_layer(
            session, text_id, &text, &event, &error) == 1);
  projected_text = {};
  projected_text.struct_size = sizeof(projected_text);
  CHECK(patchy_engine_session_text(session, text_id, &projected_text, &error) ==
        1);
  CHECK(std::string(projected_text.text, projected_text.text_size) ==
        "Edited browser text");
  CHECK(std::string(projected_text.font, projected_text.font_size) == "Arial");
  CHECK(projected_text.size_pixels == 30.0);
  CHECK(projected_text.italic == 1);
  CHECK(patchy_engine_session_undo(session, &event, &error) == 1);
  projected_text = {};
  projected_text.struct_size = sizeof(projected_text);
  CHECK(patchy_engine_session_text(session, text_id, &projected_text, &error) ==
        1);
  CHECK(std::string(projected_text.text, projected_text.text_size) ==
        "Hello browser");
  CHECK(patchy_engine_session_redo(session, &event, &error) == 1);
  projected_text = {};
  projected_text.struct_size = sizeof(projected_text);
  CHECK(patchy_engine_session_text(session, text_id, &projected_text, &error) ==
        1);
  CHECK(std::string(projected_text.text, projected_text.text_size) ==
        "Edited browser text");

  const std::array<std::uint8_t, 6> embedded_bytes{'8', 'B', 'P', 'S', 1, 2};
  const auto before_embedded = project();
  patchy_engine_smart_object_input smart{};
  smart.struct_size = sizeof(smart);
  smart.expected_state_id = before_embedded.state_id;
  smart.expected_revision = before_embedded.revision;
  smart.bounds = {2, 0, 2, 2};
  smart.width = 2;
  smart.height = 2;
  smart.rgba = pixels.data();
  smart.rgba_size = pixels.size();
  smart.name = "Embedded art";
  smart.name_size = std::strlen(smart.name);
  smart.source_kind = PATCHY_ENGINE_SMART_OBJECT_EMBEDDED;
  smart.filename = "art.psb";
  smart.filename_size = std::strlen(smart.filename);
  std::memcpy(smart.filetype, "8BPB", 4);
  smart.source_bytes = embedded_bytes.data();
  smart.source_size = embedded_bytes.size();
  CHECK(patchy_engine_session_add_smart_object(session, &smart, &event,
                                               &error) == 1);
  const auto embedded_id = event.affected_layer_id;
  patchy_engine_smart_object_projection projected_smart{};
  projected_smart.struct_size = sizeof(projected_smart);
  CHECK(patchy_engine_session_smart_object(
            session, embedded_id, &projected_smart, &error) == 1);
  CHECK(projected_smart.source_kind == PATCHY_ENGINE_SMART_OBJECT_EMBEDDED);
  CHECK(projected_smart.editable == 1);
  CHECK(projected_smart.source_size == embedded_bytes.size());
  patchy_engine_buffer exported{};
  CHECK(patchy_engine_session_smart_object_bytes(
            session, embedded_id, &exported, &error) == 1);
  CHECK(exported.size == embedded_bytes.size());
  CHECK(std::equal(exported.data, exported.data + exported.size,
                   embedded_bytes.data()));
  patchy_engine_buffer_release(&exported);

  const auto before_linked = project();
  smart.expected_state_id = before_linked.state_id;
  smart.expected_revision = before_linked.revision;
  smart.bounds = {0, 2, 2, 1};
  smart.width = 2;
  smart.height = 1;
  smart.rgba_size = 8;
  smart.name = "Linked art";
  smart.name_size = std::strlen(smart.name);
  smart.source_kind = PATCHY_ENGINE_SMART_OBJECT_EXTERNAL;
  smart.filename = "linked.png";
  smart.filename_size = std::strlen(smart.filename);
  std::memcpy(smart.filetype, "png ", 4);
  smart.source_bytes = nullptr;
  smart.source_size = 345;
  smart.external_uri = "file:///assets/linked.png";
  smart.external_uri_size = std::strlen(smart.external_uri);
  smart.external_path = "/assets/linked.png";
  smart.external_path_size = std::strlen(smart.external_path);
  smart.relative_path = "assets/linked.png";
  smart.relative_path_size = std::strlen(smart.relative_path);
  CHECK(patchy_engine_session_add_smart_object(session, &smart, &event,
                                               &error) == 1);
  const auto linked_id = event.affected_layer_id;
  projected_smart = {};
  projected_smart.struct_size = sizeof(projected_smart);
  CHECK(patchy_engine_session_smart_object(
            session, linked_id, &projected_smart, &error) == 1);
  CHECK(projected_smart.source_kind == PATCHY_ENGINE_SMART_OBJECT_EXTERNAL);
  CHECK(projected_smart.editable == 0);
  CHECK(projected_smart.source_size == 345);
  CHECK(patchy_engine_session_smart_object_bytes(
            session, linked_id, &exported, &error) == 0);
  CHECK(error.code == PATCHY_ENGINE_ERROR_INVALID_ARGUMENT);

  patchy_engine_buffer before_save{};
  CHECK(patchy_engine_session_render(session, {0, 0, 4, 3}, &before_save,
                                     &event, &error) == 1);
  patchy_engine_buffer psd{};
  const auto saved =
      patchy_engine_session_save_psd(session, &psd, &event, &error);
  if (saved != 1) {
    throw std::runtime_error(std::string("host PSD save failed: ") +
                             error.message);
  }
  auto *reopened = patchy_engine_session_open_psd(runtime, psd.data, psd.size,
                                                  &error);
  CHECK(reopened != nullptr);
  projected_text = {};
  projected_text.struct_size = sizeof(projected_text);
  CHECK(patchy_engine_session_text(reopened, text_id, &projected_text, &error) ==
        1);
  CHECK(std::string(projected_text.text, projected_text.text_size) ==
        "Edited browser text");
  projected_smart = {};
  projected_smart.struct_size = sizeof(projected_smart);
  CHECK(patchy_engine_session_smart_object(
            reopened, embedded_id, &projected_smart, &error) == 1);
  CHECK(projected_smart.source_size == embedded_bytes.size());
  CHECK(patchy_engine_session_smart_object(
            reopened, linked_id, &projected_smart, &error) == 1);
  CHECK(projected_smart.source_kind == PATCHY_ENGINE_SMART_OBJECT_EXTERNAL);
  patchy_engine_buffer after_reopen{};
  CHECK(patchy_engine_session_render(reopened, {0, 0, 4, 3}, &after_reopen,
                                     &event, &error) == 1);
  CHECK(after_reopen.size == before_save.size);
  CHECK(std::equal(after_reopen.data, after_reopen.data + after_reopen.size,
                   before_save.data));

  patchy_engine_buffer_release(&after_reopen);
  patchy_engine_buffer_release(&before_save);
  patchy_engine_session_destroy(reopened);
  patchy_engine_buffer_release(&psd);
  patchy_engine_session_destroy(session);
  patchy_engine_runtime_destroy(runtime);
}

void engine_host_protocol_authors_nondestructive_workflow() {
  patchy_engine_error error{};
  auto *runtime = patchy_engine_runtime_create(
      PATCHY_ENGINE_HOST_PROTOCOL_VERSION, &error);
  CHECK(runtime != nullptr);
  auto *session = patchy_engine_session_create_rgba8(runtime, 6, 4, &error);
  CHECK(session != nullptr);
  const auto project = [&]() {
    patchy_engine_document_projection document{};
    document.struct_size = sizeof(document);
    CHECK(patchy_engine_session_document(session, &document, &error) == 1);
    return document;
  };
  patchy_engine_event event{};
  std::vector<std::uint8_t> pixels(4U * 4U * 4U, 255U);
  for (std::size_t index = 0; index < pixels.size(); index += 4U) {
    pixels[index] = static_cast<std::uint8_t>(20U + index);
    pixels[index + 1U] = 80U;
    pixels[index + 2U] = 140U;
  }
  const auto initial = project();
  patchy_engine_pixel_layer_input add{};
  add.struct_size = sizeof(add);
  add.expected_state_id = initial.state_id;
  add.expected_revision = initial.revision;
  add.bounds = {0, 0, 4, 4};
  add.width = 4;
  add.height = 4;
  add.rgba = pixels.data();
  add.rgba_size = pixels.size();
  add.name = "Masked pixels";
  add.name_size = std::strlen(add.name);
  CHECK(patchy_engine_session_add_rgba8_layer(session, &add, &event, &error) ==
        1);
  const auto pixel_id = event.affected_layer_id;

  const patchy_engine_path_anchor anchors[] = {
      {0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0},
      {3.0, 0.0, 3.0, 0.0, 3.0, 0.0, 0},
      {3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 0},
      {0.0, 3.0, 0.0, 3.0, 0.0, 3.0, 0},
  };
  const patchy_engine_path_subpath_input subpath{
      0, 4, 0, PATCHY_ENGINE_PATH_ADD, 1};
  const auto before_mask = project();
  patchy_engine_vector_mask_input vector_mask{};
  vector_mask.struct_size = sizeof(vector_mask);
  vector_mask.expected_state_id = before_mask.state_id;
  vector_mask.expected_revision = before_mask.revision;
  vector_mask.layer_id = pixel_id;
  vector_mask.path = {&subpath, 1, anchors, 4};
  vector_mask.feather = 0.5;
  vector_mask.density = 210;
  vector_mask.unlinked = 1;
  vector_mask.has_mask = 1;
  CHECK(patchy_engine_session_set_vector_mask(
            session, &vector_mask, &event, &error) == 1);
  patchy_engine_vector_mask_projection projected_mask{};
  projected_mask.struct_size = sizeof(projected_mask);
  CHECK(patchy_engine_session_vector_mask(
            session, pixel_id, &projected_mask, &error) == 1);
  CHECK(projected_mask.subpath_count == 1);
  CHECK(projected_mask.anchor_count == 4);
  CHECK(projected_mask.density == 210);
  CHECK(projected_mask.unlinked == 1);

  const patchy_engine_curve_point curve[] = {{0, 10}, {128, 170}, {255, 245}};
  const auto before_adjustment = project();
  patchy_engine_adjustment_input adjustment{};
  adjustment.struct_size = sizeof(adjustment);
  adjustment.expected_state_id = before_adjustment.state_id;
  adjustment.expected_revision = before_adjustment.revision;
  adjustment.name = "Browser curves";
  adjustment.name_size = std::strlen(adjustment.name);
  adjustment.kind = PATCHY_ENGINE_ADJUSTMENT_CURVES;
  adjustment.curve_points = curve;
  adjustment.curve_point_count = std::size(curve);
  CHECK(patchy_engine_session_set_adjustment(
            session, &adjustment, &event, &error) == 1);
  const auto adjustment_id = event.affected_layer_id;
  patchy_engine_adjustment_projection projected_adjustment{};
  projected_adjustment.struct_size = sizeof(projected_adjustment);
  CHECK(patchy_engine_session_adjustment(
            session, adjustment_id, &projected_adjustment, &error) == 1);
  CHECK(projected_adjustment.kind == PATCHY_ENGINE_ADJUSTMENT_CURVES);
  CHECK(projected_adjustment.curve_point_count == 3);
  patchy_engine_curve_point projected_point{};
  CHECK(patchy_engine_session_adjustment_curve_point_at(
            session, adjustment_id, 1, &projected_point, &error) == 1);
  CHECK(projected_point.input == 128);
  CHECK(projected_point.output == 170);

  const auto before_update = project();
  adjustment.expected_state_id = before_update.state_id;
  adjustment.expected_revision = before_update.revision;
  adjustment.layer_id = adjustment_id;
  adjustment.update_existing = 1;
  adjustment.kind = PATCHY_ENGINE_ADJUSTMENT_BRIGHTNESS_CONTRAST;
  adjustment.values[0] = 18;
  adjustment.values[1] = -9;
  adjustment.values[2] = 1;
  adjustment.curve_points = nullptr;
  adjustment.curve_point_count = 0;
  CHECK(patchy_engine_session_set_adjustment(
            session, &adjustment, &event, &error) == 1);
  projected_adjustment = {};
  projected_adjustment.struct_size = sizeof(projected_adjustment);
  CHECK(patchy_engine_session_adjustment(
            session, adjustment_id, &projected_adjustment, &error) == 1);
  CHECK(projected_adjustment.kind ==
        PATCHY_ENGINE_ADJUSTMENT_BRIGHTNESS_CONTRAST);
  CHECK(projected_adjustment.values[0] == 18);
  CHECK(projected_adjustment.values[1] == -9);
  const auto before_curve_restore = project();
  const patchy_engine_curve_point updated_curve[] = {{0, 20}, {255, 230}};
  adjustment.expected_state_id = before_curve_restore.state_id;
  adjustment.expected_revision = before_curve_restore.revision;
  adjustment.kind = PATCHY_ENGINE_ADJUSTMENT_CURVES;
  adjustment.curve_points = updated_curve;
  adjustment.curve_point_count = std::size(updated_curve);
  CHECK(patchy_engine_session_set_adjustment(
            session, &adjustment, &event, &error) == 1);

  const std::array<std::uint8_t, 8> source_bytes{'8', 'B', 'P', 'S', 4, 3, 2,
                                                  1};
  const auto before_smart = project();
  patchy_engine_smart_object_input smart{};
  smart.struct_size = sizeof(smart);
  smart.expected_state_id = before_smart.state_id;
  smart.expected_revision = before_smart.revision;
  smart.bounds = {2, 0, 4, 4};
  smart.width = 4;
  smart.height = 4;
  smart.rgba = pixels.data();
  smart.rgba_size = pixels.size();
  smart.name = "Filtered object";
  smart.name_size = std::strlen(smart.name);
  smart.source_kind = PATCHY_ENGINE_SMART_OBJECT_EMBEDDED;
  smart.filename = "filter-source.psb";
  smart.filename_size = std::strlen(smart.filename);
  std::memcpy(smart.filetype, "8BPB", 4);
  smart.source_bytes = source_bytes.data();
  smart.source_size = source_bytes.size();
  CHECK(patchy_engine_session_add_smart_object(
            session, &smart, &event, &error) == 1);
  const auto smart_id = event.affected_layer_id;
  const auto before_filter = project();
  patchy_engine_smart_filter_input filter{};
  filter.struct_size = sizeof(filter);
  filter.expected_state_id = before_filter.state_id;
  filter.expected_revision = before_filter.revision;
  filter.layer_id = smart_id;
  filter.kind = PATCHY_ENGINE_SMART_FILTER_GAUSSIAN_BLUR;
  filter.amount = 1.25;
  filter.enabled = 1;
  CHECK(patchy_engine_session_set_smart_filter(
            session, &filter, &event, &error) == 1);
  patchy_engine_smart_filter_projection projected_filter{};
  projected_filter.struct_size = sizeof(projected_filter);
  CHECK(patchy_engine_session_smart_filter(
            session, smart_id, &projected_filter, &error) == 1);
  CHECK(projected_filter.entry_count == 1);
  CHECK(projected_filter.first_kind ==
        PATCHY_ENGINE_SMART_FILTER_GAUSSIAN_BLUR);
  CHECK(projected_filter.first_amount == 1.25);

  const auto smart_revision_before_replace = project().revision;
  const std::array<std::uint8_t, 9> replacement_bytes{
      '8', 'B', 'P', 'S', 9, 8, 7, 6, 5};
  auto replacement_pixels = pixels;
  replacement_pixels[0] = 240;
  const auto before_replace = project();
  smart.expected_state_id = before_replace.state_id;
  smart.expected_revision = before_replace.revision;
  smart.rgba = replacement_pixels.data();
  smart.rgba_size = replacement_pixels.size();
  smart.name = "Replaced object";
  smart.name_size = std::strlen(smart.name);
  smart.filename = "replacement.psb";
  smart.filename_size = std::strlen(smart.filename);
  smart.source_bytes = replacement_bytes.data();
  smart.source_size = replacement_bytes.size();
  CHECK(patchy_engine_session_replace_smart_object(
            session, smart_id, &smart, &event, &error) == 1);
  CHECK(project().revision == smart_revision_before_replace + 1);
  patchy_engine_smart_object_projection projected_smart{};
  projected_smart.struct_size = sizeof(projected_smart);
  CHECK(patchy_engine_session_smart_object(
            session, smart_id, &projected_smart, &error) == 1);
  CHECK(std::string(projected_smart.filename, projected_smart.filename_size) ==
        "replacement.psb");
  CHECK(projected_smart.source_size == replacement_bytes.size());
  CHECK(patchy_engine_session_undo(session, &event, &error) == 1);
  projected_smart = {};
  projected_smart.struct_size = sizeof(projected_smart);
  CHECK(patchy_engine_session_smart_object(
            session, smart_id, &projected_smart, &error) == 1);
  CHECK(std::string(projected_smart.filename, projected_smart.filename_size) ==
        "filter-source.psb");
  CHECK(patchy_engine_session_redo(session, &event, &error) == 1);

  patchy_engine_buffer rendered{};
  CHECK(patchy_engine_session_render(session, {0, 0, 6, 4}, &rendered,
                                     &event, &error) == 1);
  patchy_engine_buffer psd{};
  CHECK(patchy_engine_session_save_psd(session, &psd, &event, &error) == 1);
  auto *reopened = patchy_engine_session_open_psd(runtime, psd.data, psd.size,
                                                  &error);
  CHECK(reopened != nullptr);
  projected_mask = {};
  projected_mask.struct_size = sizeof(projected_mask);
  CHECK(patchy_engine_session_vector_mask(
            reopened, pixel_id, &projected_mask, &error) == 1);
  projected_adjustment = {};
  projected_adjustment.struct_size = sizeof(projected_adjustment);
  CHECK(patchy_engine_session_adjustment(
            reopened, adjustment_id, &projected_adjustment, &error) == 1);
  CHECK(projected_adjustment.curve_point_count == 2);
  projected_filter = {};
  projected_filter.struct_size = sizeof(projected_filter);
  CHECK(patchy_engine_session_smart_filter(
            reopened, smart_id, &projected_filter, &error) == 1);
  CHECK(projected_filter.first_amount == 1.25);
  projected_smart = {};
  projected_smart.struct_size = sizeof(projected_smart);
  CHECK(patchy_engine_session_smart_object(
            reopened, smart_id, &projected_smart, &error) == 1);
  CHECK(projected_smart.source_size == replacement_bytes.size());
  patchy_engine_buffer reopened_render{};
  CHECK(patchy_engine_session_render(reopened, {0, 0, 6, 4},
                                     &reopened_render, &event, &error) == 1);
  CHECK(reopened_render.size == rendered.size);
  CHECK(std::equal(reopened_render.data,
                   reopened_render.data + reopened_render.size,
                   rendered.data));

  patchy_engine_buffer_release(&reopened_render);
  patchy_engine_buffer_release(&rendered);
  patchy_engine_session_destroy(reopened);
  patchy_engine_buffer_release(&psd);
  patchy_engine_session_destroy(session);
  patchy_engine_runtime_destroy(runtime);
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
      {"engine_session_nondestructive_layer_state_is_atomic_and_round_trips",
       engine_session_nondestructive_layer_state_is_atomic_and_round_trips},
      {"engine_session_crop_and_wrap_geometry_are_atomic_and_restore_selection",
       engine_session_crop_and_wrap_geometry_are_atomic_and_restore_selection},
      {"engine_session_rejects_non_atomic_lifecycle_commands",
       engine_session_rejects_non_atomic_lifecycle_commands},
      {"engine_session_headless_psd_open_edit_save_reopen",
       engine_session_headless_psd_open_edit_save_reopen},
      {"engine_session_save_reports_progress_and_cancels_without_partial_bytes",
       engine_session_save_reports_progress_and_cancels_without_partial_bytes},
      {"engine_session_renders_bounded_rgba_regions_and_cancels",
       engine_session_renders_bounded_rgba_regions_and_cancels},
      {"engine_session_coalesces_dirty_render_regions_and_publishes_them",
       engine_session_coalesces_dirty_render_regions_and_publishes_them},
      {"engine_session_external_shell_adapter_preserves_state_identity",
       engine_session_external_shell_adapter_preserves_state_identity},
      {"engine_selection_snapshot_is_qt_free_and_accounts_retained_bytes",
       engine_selection_snapshot_is_qt_free_and_accounts_retained_bytes},
      {"engine_session_memory_census_is_cow_aware_across_owned_state",
       engine_session_memory_census_is_cow_aware_across_owned_state},
      {"engine_session_prepared_selection_commit_rejects_stale_gestures",
       engine_session_prepared_selection_commit_rejects_stale_gestures},
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
      {"engine_session_commits_prepared_document_state_with_stale_guard",
       engine_session_commits_prepared_document_state_with_stale_guard},
      {"engine_host_protocol_runs_versioned_native_wasm_sequence",
       engine_host_protocol_runs_versioned_native_wasm_sequence},
      {"engine_host_protocol_authors_layers_and_document_geometry",
       engine_host_protocol_authors_layers_and_document_geometry},
      {"engine_host_protocol_authors_pixels_channels_and_selection",
       engine_host_protocol_authors_pixels_channels_and_selection},
      {"engine_host_protocol_runs_mask_filter_async_lifecycle",
       engine_host_protocol_runs_mask_filter_async_lifecycle},
      {"engine_host_protocol_authors_text_and_smart_objects",
       engine_host_protocol_authors_text_and_smart_objects},
      {"engine_host_protocol_authors_nondestructive_workflow",
       engine_host_protocol_authors_nondestructive_workflow},
  };
}
