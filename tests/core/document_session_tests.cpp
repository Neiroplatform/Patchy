#include "engine/document_session.hpp"

#include "psd/psd_document_io.hpp"
#include "test_groups.hpp"
#include "test_harness.hpp"

#include <cmath>
#include <cstdint>
#include <utility>
#include <vector>

using patchy::Document;
using patchy::PixelBuffer;
using patchy::PixelFormat;
using patchy::engine::AddGroup;
using patchy::engine::AddPixelLayer;
using patchy::engine::CancellationToken;
using patchy::engine::DocumentSession;
using patchy::engine::MoveLayers;
using patchy::engine::open_psd;
using patchy::engine::RemoveLayers;
using patchy::engine::RenameLayer;
using patchy::engine::ResizeCanvas;
using patchy::engine::ResizeImage;
using patchy::engine::SessionErrorCode;
using patchy::engine::SessionEvent;
using patchy::engine::SessionEventKind;
using patchy::engine::SetLayerBlendMode;
using patchy::engine::SetLayerFillOpacity;
using patchy::engine::SetLayerOpacity;
using patchy::engine::SetLayerVisibility;
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

void engine_session_rejects_non_atomic_lifecycle_commands() {
  DocumentSession session(make_session_document());
  const auto original_state = session.state_id();
  const auto original_id = session.document().layers().front().id();

  CHECK(
      !static_cast<bool>(session.execute(RemoveLayers{{original_id, 999999}})));
  CHECK(!static_cast<bool>(session.execute(ResizeImage{0, 10})));
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
  const auto rendered = session.render(patchy::Rect{1, 0, 1, 2});
  CHECK(static_cast<bool>(rendered));
  CHECK(rendered.pixels.width() == 1);
  CHECK(rendered.pixels.height() == 2);
  CHECK(rendered.pixels.pixel(0, 0)[0] == 12);
  CHECK(rendered.pixels.pixel(0, 0)[1] == 34);
  CHECK(rendered.pixels.pixel(0, 0)[2] == 56);
  CHECK(rendered.pixels.pixel(0, 0)[3] == 255);

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
      {"engine_session_rejects_non_atomic_lifecycle_commands",
       engine_session_rejects_non_atomic_lifecycle_commands},
      {"engine_session_headless_psd_open_edit_save_reopen",
       engine_session_headless_psd_open_edit_save_reopen},
      {"engine_session_renders_bounded_rgba_regions_and_cancels",
       engine_session_renders_bounded_rgba_regions_and_cancels},
      {"engine_session_external_shell_adapter_preserves_state_identity",
       engine_session_external_shell_adapter_preserves_state_identity},
  };
}
