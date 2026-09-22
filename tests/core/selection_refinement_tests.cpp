#include "engine/host_protocol.h"

#include "test_groups.hpp"
#include "test_harness.hpp"

#include <algorithm>
#include <cstdint>
#include <limits>
#include <vector>

namespace {

patchy_engine_document_projection project_document(
    patchy_engine_session *session, patchy_engine_error *error) {
  patchy_engine_document_projection projection{};
  projection.struct_size = sizeof(projection);
  CHECK(patchy_engine_session_document(session, &projection, error) == 1);
  return projection;
}

void set_refinement_fixture_selection(patchy_engine_session *session,
                                      patchy_engine_error *error) {
  const auto projection = project_document(session, error);
  const patchy_engine_rect rect{8, 8, 16, 16};
  patchy_engine_selection_input input{};
  input.struct_size = sizeof(input);
  input.expected_state_id = projection.state_id;
  input.expected_revision = projection.revision;
  input.rects = &rect;
  input.rect_count = 1;
  patchy_engine_event event{};
  CHECK(patchy_engine_session_set_selection(session, &input, &event, error) == 1);
  CHECK(event.changed == 1);
}

patchy_engine_selection_refinement_input refinement_input(
    const patchy_engine_document_projection &projection) {
  patchy_engine_selection_refinement_input input{};
  input.struct_size = sizeof(input);
  input.output = PATCHY_ENGINE_SELECTION_REFINEMENT_SELECTION;
  input.expected_state_id = projection.state_id;
  input.expected_revision = projection.revision;
  input.smooth = 2;
  input.feather = 3.0;
  input.contrast = 20;
  input.shift_edge = 1;
  return input;
}

std::uint64_t add_refinement_pixel_layer(patchy_engine_session *session,
                                         patchy_engine_error *error) {
  const auto before = project_document(session, error);
  std::vector<std::uint8_t> rgba(
      static_cast<std::size_t>(before.width) * before.height * 4U, 255U);
  constexpr char name[] = "Refinement target";
  patchy_engine_pixel_layer_input input{};
  input.struct_size = sizeof(input);
  input.expected_state_id = before.state_id;
  input.expected_revision = before.revision;
  input.bounds = {0, 0, before.width, before.height};
  input.width = before.width;
  input.height = before.height;
  input.rgba = rgba.data();
  input.rgba_size = rgba.size();
  input.name = name;
  input.name_size = sizeof(name) - 1U;
  patchy_engine_event event{};
  CHECK(patchy_engine_session_add_rgba8_layer(
            session, &input, &event, error) == 1);
  const auto after = project_document(session, error);
  CHECK(after.has_active_layer == 1);
  return after.active_layer_id;
}

void selection_refinement_preview_and_commit_share_engine_pixels() {
  patchy_engine_error error{};
  auto *runtime = patchy_engine_runtime_create(
      PATCHY_ENGINE_HOST_PROTOCOL_VERSION, &error);
  CHECK(runtime != nullptr);
  auto *session = patchy_engine_session_create_rgba8(runtime, 40, 40, &error);
  CHECK(session != nullptr);
  set_refinement_fixture_selection(session, &error);

  const auto before = project_document(session, &error);
  auto input = refinement_input(before);
  patchy_engine_rect bounds{};
  patchy_engine_buffer preview{};
  CHECK(patchy_engine_session_preview_selection_refinement(
            session, &input, nullptr, nullptr, &bounds, &preview, &error) == 1);
  CHECK(bounds.width > 0);
  CHECK(bounds.height > 0);
  CHECK(preview.size == static_cast<std::size_t>(bounds.width) * bounds.height);
  CHECK(project_document(session, &error).revision == before.revision);
  CHECK(project_document(session, &error).state_id == before.state_id);

  const std::vector<std::uint8_t> expected(preview.data,
                                           preview.data + preview.size);
  patchy_engine_buffer_release(&preview);
  patchy_engine_event event{};
  CHECK(patchy_engine_session_apply_selection_refinement(
            session, &input, &event, &error) == 1);
  CHECK(event.changed == 1);
  CHECK(event.dirty == 0);
  CHECK(event.revision == before.revision + 1);
  CHECK(event.state_id == before.state_id);

  patchy_engine_selection_projection selection{};
  selection.struct_size = sizeof(selection);
  CHECK(patchy_engine_session_selection(session, &selection, &error) == 1);
  CHECK(selection.has_mask == 1);
  CHECK(selection.mask_bounds.x == bounds.x);
  CHECK(selection.mask_bounds.y == bounds.y);
  CHECK(selection.mask_bounds.width == bounds.width);
  CHECK(selection.mask_bounds.height == bounds.height);
  patchy_engine_buffer committed{};
  CHECK(patchy_engine_session_selection_mask(session, &committed, &error) == 1);
  CHECK(committed.size == expected.size());
  CHECK(std::equal(expected.begin(), expected.end(), committed.data));
  patchy_engine_buffer_release(&committed);

  CHECK(patchy_engine_session_apply_selection_refinement(
            session, &input, &event, &error) == 0);
  CHECK(error.code == PATCHY_ENGINE_ERROR_STALE_STATE);
  CHECK(patchy_engine_session_undo(session, &event, &error) == 1);
  CHECK(patchy_engine_session_redo(session, &event, &error) == 1);
  patchy_engine_session_destroy(session);
  patchy_engine_runtime_destroy(runtime);
}

void selection_refinement_outputs_one_roundtripping_layer_mask() {
  patchy_engine_error error{};
  auto *runtime = patchy_engine_runtime_create(
      PATCHY_ENGINE_HOST_PROTOCOL_VERSION, &error);
  CHECK(runtime != nullptr);
  auto *session = patchy_engine_session_create_rgba8(runtime, 40, 40, &error);
  CHECK(session != nullptr);
  const auto target_layer_id = add_refinement_pixel_layer(session, &error);
  set_refinement_fixture_selection(session, &error);
  const auto before = project_document(session, &error);
  auto input = refinement_input(before);
  input.output = PATCHY_ENGINE_SELECTION_REFINEMENT_LAYER_MASK;
  input.layer_id = target_layer_id;

  patchy_engine_rect bounds{};
  patchy_engine_buffer preview{};
  CHECK(patchy_engine_session_preview_selection_refinement(
            session, &input, nullptr, nullptr, &bounds, &preview, &error) == 1);
  const std::vector<std::uint8_t> expected(preview.data,
                                           preview.data + preview.size);
  patchy_engine_buffer_release(&preview);
  patchy_engine_event event{};
  CHECK(patchy_engine_session_apply_selection_refinement(
            session, &input, &event, &error) == 1);
  CHECK(event.changed == 1);
  CHECK(event.dirty == 1);
  CHECK(event.state_id != before.state_id);
  CHECK(event.affected_layer_id == target_layer_id);

  auto repeated = input;
  const auto applied = project_document(session, &error);
  repeated.expected_state_id = applied.state_id;
  repeated.expected_revision = applied.revision;
  CHECK(patchy_engine_session_apply_selection_refinement(
            session, &repeated, &event, &error) == 0);
  CHECK(project_document(session, &error).revision == applied.revision);
  CHECK(project_document(session, &error).state_id == applied.state_id);

  patchy_engine_layer_mask_projection mask{};
  mask.struct_size = sizeof(mask);
  CHECK(patchy_engine_session_layer_mask(
            session, target_layer_id, &mask, &error) == 1);
  CHECK(mask.has_mask == 1);
  CHECK(mask.bounds.width == bounds.width);
  CHECK(mask.bounds.height == bounds.height);
  patchy_engine_buffer pixels{};
  CHECK(patchy_engine_session_layer_mask_pixels(
            session, target_layer_id, &pixels, &error) == 1);
  CHECK(pixels.size == expected.size());
  CHECK(std::equal(expected.begin(), expected.end(), pixels.data));
  patchy_engine_buffer_release(&pixels);

  CHECK(patchy_engine_session_undo(session, &event, &error) == 1);
  mask = {};
  mask.struct_size = sizeof(mask);
  CHECK(patchy_engine_session_layer_mask(
            session, target_layer_id, &mask, &error) == 1);
  CHECK(mask.has_mask == 0);
  CHECK(patchy_engine_session_redo(session, &event, &error) == 1);

  for (const auto large_document : {false, true}) {
    patchy_engine_buffer saved{};
    CHECK(patchy_engine_session_save_psd_as(
              session, large_document ? 1 : 0, &saved, &event, &error) == 1);
    auto *reopened = patchy_engine_session_open_psd(
        runtime, saved.data, saved.size, &error);
    CHECK(reopened != nullptr);
    mask = {};
    mask.struct_size = sizeof(mask);
    CHECK(patchy_engine_session_layer_mask(
              reopened, target_layer_id, &mask, &error) == 1);
    CHECK(mask.has_mask == 1);
    CHECK(mask.bounds.width == bounds.width);
    CHECK(mask.bounds.height == bounds.height);
    patchy_engine_session_destroy(reopened);
    patchy_engine_buffer_release(&saved);
  }
  patchy_engine_session_destroy(session);
  patchy_engine_runtime_destroy(runtime);
}

void selection_refinement_rejects_empty_noop_and_invalid_target() {
  patchy_engine_error error{};
  auto *runtime = patchy_engine_runtime_create(
      PATCHY_ENGINE_HOST_PROTOCOL_VERSION, &error);
  CHECK(runtime != nullptr);
  auto *session = patchy_engine_session_create_rgba8(runtime, 24, 24, &error);
  CHECK(session != nullptr);
  const auto opened = project_document(session, &error);
  auto input = refinement_input(opened);
  patchy_engine_rect bounds{};
  patchy_engine_buffer preview{};
  CHECK(patchy_engine_session_preview_selection_refinement(
            session, &input, nullptr, nullptr, &bounds, &preview, &error) == 0);
  CHECK(project_document(session, &error).revision == opened.revision);

  set_refinement_fixture_selection(session, &error);
  const auto selected = project_document(session, &error);
  input = refinement_input(selected);
  const auto cancel = [](std::int32_t, std::int32_t, void *) -> int { return 0; };
  CHECK(patchy_engine_session_preview_selection_refinement(
            session, &input, cancel, nullptr, &bounds, &preview, &error) == 0);
  CHECK(error.code == PATCHY_ENGINE_ERROR_CANCELLED);
  CHECK(preview.data == nullptr);
  CHECK(preview.size == 0);
  CHECK(project_document(session, &error).revision == selected.revision);
  CHECK(project_document(session, &error).state_id == selected.state_id);

  input = refinement_input(selected);
  input.smooth = 0;
  input.feather = 0;
  input.contrast = 0;
  input.shift_edge = 0;
  patchy_engine_event event{};
  CHECK(patchy_engine_session_apply_selection_refinement(
            session, &input, &event, &error) == 0);
  CHECK(project_document(session, &error).revision == selected.revision);

  input = refinement_input(selected);
  input.smooth = 0;
  input.feather = 0;
  input.contrast = 20;
  input.shift_edge = 0;
  CHECK(patchy_engine_session_apply_selection_refinement(
            session, &input, &event, &error) == 0);
  CHECK(project_document(session, &error).revision == selected.revision);
  CHECK(project_document(session, &error).state_id == selected.state_id);

  input = refinement_input(selected);
  input.feather = std::numeric_limits<double>::quiet_NaN();
  CHECK(patchy_engine_session_apply_selection_refinement(
            session, &input, &event, &error) == 0);
  CHECK(project_document(session, &error).revision == selected.revision);

  input = refinement_input(selected);
  input.smooth = 251;
  CHECK(patchy_engine_session_apply_selection_refinement(
            session, &input, &event, &error) == 0);
  CHECK(project_document(session, &error).revision == selected.revision);

  input = refinement_input(selected);
  input.output = PATCHY_ENGINE_SELECTION_REFINEMENT_LAYER_MASK;
  input.layer_id = UINT64_C(999999);
  CHECK(patchy_engine_session_apply_selection_refinement(
            session, &input, &event, &error) == 0);
  CHECK(project_document(session, &error).revision == selected.revision);
  CHECK(project_document(session, &error).state_id == selected.state_id);
  patchy_engine_session_destroy(session);

  session = patchy_engine_session_create_rgba8(runtime, 4097, 4097, &error);
  CHECK(session != nullptr);
  set_refinement_fixture_selection(session, &error);
  const auto oversized = project_document(session, &error);
  input = refinement_input(oversized);
  CHECK(patchy_engine_session_preview_selection_refinement(
            session, &input, nullptr, nullptr, &bounds, &preview, &error) == 0);
  CHECK(preview.data == nullptr);
  CHECK(preview.size == 0);
  CHECK(project_document(session, &error).revision == oversized.revision);
  CHECK(project_document(session, &error).state_id == oversized.state_id);
  patchy_engine_session_destroy(session);
  patchy_engine_runtime_destroy(runtime);
}

} // namespace

std::vector<patchy::test::TestCase> selection_refinement_tests() {
  return {
      {"selection_refinement_preview_and_commit_share_engine_pixels",
       selection_refinement_preview_and_commit_share_engine_pixels},
      {"selection_refinement_outputs_one_roundtripping_layer_mask",
       selection_refinement_outputs_one_roundtripping_layer_mask},
      {"selection_refinement_rejects_empty_noop_and_invalid_target",
       selection_refinement_rejects_empty_noop_and_invalid_target},
  };
}
