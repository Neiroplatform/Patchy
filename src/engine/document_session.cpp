#include "engine/document_session.hpp"

#include "formats/document_flatten.hpp"
#include "psd/psd_document_io.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <exception>
#include <type_traits>
#include <utility>

namespace patchy::engine {

namespace {

SessionError make_error(SessionErrorCode code, std::string message) {
  return SessionError{code, std::move(message)};
}

} // namespace

DocumentSession::DocumentSession(Document document)
    : document_(std::move(document)) {}

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
  undo_stack_.push_back(HistoryState{document_, state_id_});
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

CommandResult DocumentSession::execute(const DocumentCommand &command) {
  return execute_impl(command, true);
}

CommandResult
DocumentSession::execute_external(const DocumentCommand &command) {
  return execute_impl(command, false);
}

CommandResult DocumentSession::execute_impl(const DocumentCommand &command,
                                            bool record_history) {
  LayerId layer_id = 0;
  bool changed = false;
  SessionError error{};

  try {
    std::visit(
        [this, record_history, &layer_id, &changed,
         &error](const auto &concrete) {
          using Command = std::decay_t<decltype(concrete)>;
          if constexpr (std::is_same_v<Command, ResizeImage> ||
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
            changed = true;
            return;
          } else if constexpr (std::is_same_v<Command, AddPixelLayer> ||
                               std::is_same_v<Command, AddGroup>) {
            auto added_document = document_;
            if constexpr (std::is_same_v<Command, AddPixelLayer>) {
              layer_id =
                  added_document.add_pixel_layer(concrete.name, concrete.pixels)
                      .id();
            } else {
              layer_id = added_document.allocate_layer_id();
              added_document.add_layer(
                  Layer(layer_id, concrete.name, LayerKind::Group));
            }
            prepare_mutation(record_history);
            document_ = std::move(added_document);
            changed = true;
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
  } catch (const std::exception &exception) {
    error = make_error(SessionErrorCode::CommandFailed, exception.what());
  }

  if (error) {
    return CommandResult{false, std::move(error)};
  }
  if (changed) {
    state_id_ = next_state_id_++;
    ++revision_;
    publish(SessionEventKind::CommandApplied, layer_id);
  }
  return CommandResult{changed, {}, layer_id};
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

  destination.push_back(HistoryState{std::move(document_), state_id_});
  auto restored = std::move(source.back());
  source.pop_back();
  document_ = std::move(restored.document);
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
    const auto flattened = flatten_document_rgba8(document_);
    if (cancellation != nullptr && cancellation->cancelled()) {
      return RenderResult{
          {},
          region,
          revision_,
          make_error(SessionErrorCode::Cancelled, "render cancelled")};
    }
    PixelBuffer output(region.width, region.height, PixelFormat::rgba8());
    const auto row_bytes = static_cast<std::size_t>(region.width) * 4U;
    for (std::int32_t row = 0; row < region.height; ++row) {
      const auto source = flattened.row(region.y + row);
      auto destination = output.row(row);
      const auto source_offset = static_cast<std::size_t>(region.x) * 4U;
      std::memcpy(destination.data(), source.data() + source_offset, row_bytes);
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
                                       std::uint64_t state_id) {
  document_ = std::move(document);
  undo_stack_.clear();
  redo_stack_.clear();
  state_id_ = state_id;
  next_state_id_ = std::max(next_state_id_, state_id + 1U);
  ++revision_;
}

void DocumentSession::replace_external(Document document, bool saved) {
  document_ = std::move(document);
  undo_stack_.clear();
  redo_stack_.clear();
  state_id_ = next_state_id_++;
  ++revision_;
  if (saved) {
    saved_state_id_ = state_id_;
  }
}

} // namespace patchy::engine
