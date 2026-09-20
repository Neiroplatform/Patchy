#pragma once

#include "core/document.hpp"
#include "core/layer_tree.hpp"

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <span>
#include <string>
#include <variant>
#include <vector>

namespace patchy::engine {

enum class SessionErrorCode {
  None,
  InvalidArgument,
  LayerNotFound,
  NoUndoState,
  NoRedoState,
  DecodeFailed,
  EncodeFailed,
  RenderFailed,
  Cancelled,
};

struct SessionError {
  SessionErrorCode code{SessionErrorCode::None};
  std::string message{};

  [[nodiscard]] explicit operator bool() const noexcept {
    return code != SessionErrorCode::None;
  }
};

struct SetLayerVisibility {
  LayerId layer_id{0};
  bool visible{true};
};

struct SetLayerOpacity {
  LayerId layer_id{0};
  float opacity{1.0F};
};

struct RenameLayer {
  LayerId layer_id{0};
  std::string name{};
};

struct MoveLayers {
  std::vector<LayerId> layer_ids_top_to_bottom{};
  std::optional<LayerId> target_layer_id{};
  LayerDropPosition position{LayerDropPosition::OnViewport};
};

using DocumentCommand =
    std::variant<SetLayerVisibility, SetLayerOpacity, RenameLayer, MoveLayers>;

struct LayerInfo {
  LayerId id{0};
  LayerId parent_id{0};
  LayerKind kind{LayerKind::Pixel};
  std::string name{};
  bool visible{true};
  float opacity{1.0F};
};

enum class SessionEventKind {
  CommandApplied,
  UndoApplied,
  RedoApplied,
  Saved,
};

struct SessionEvent {
  SessionEventKind kind{SessionEventKind::CommandApplied};
  std::uint64_t revision{0};
  std::uint64_t state_id{0};
  bool dirty{false};
  LayerId layer_id{0};
};

struct CommandResult {
  bool changed{false};
  SessionError error{};

  [[nodiscard]] explicit operator bool() const noexcept { return !error; }
};

struct SaveResult {
  std::vector<std::uint8_t> bytes{};
  SessionError error{};

  [[nodiscard]] explicit operator bool() const noexcept { return !error; }
};

class CancellationToken {
public:
  void cancel() noexcept { cancelled_.store(true, std::memory_order_relaxed); }
  [[nodiscard]] bool cancelled() const noexcept {
    return cancelled_.load(std::memory_order_relaxed);
  }

private:
  std::atomic_bool cancelled_{false};
};

struct RenderResult {
  PixelBuffer pixels{};
  Rect region{};
  std::uint64_t revision{0};
  SessionError error{};

  [[nodiscard]] explicit operator bool() const noexcept { return !error; }
};

class DocumentSession {
public:
  using EventSink = std::function<void(const SessionEvent &)>;

  explicit DocumentSession(Document document);

  [[nodiscard]] const Document &document() const noexcept { return document_; }
  // Transitional adapter for the existing Qt shell. New engine consumers mutate
  // through execute(); the shell pairs direct mutations with
  // mark_external_modified().
  [[nodiscard]] Document &mutable_document() noexcept { return document_; }
  [[nodiscard]] std::uint64_t revision() const noexcept { return revision_; }
  [[nodiscard]] std::uint64_t state_id() const noexcept { return state_id_; }
  [[nodiscard]] bool dirty() const noexcept {
    return state_id_ != saved_state_id_;
  }
  [[nodiscard]] bool can_undo() const noexcept { return !undo_stack_.empty(); }
  [[nodiscard]] bool can_redo() const noexcept { return !redo_stack_.empty(); }
  [[nodiscard]] std::size_t undo_size() const noexcept {
    return undo_stack_.size();
  }
  [[nodiscard]] std::size_t redo_size() const noexcept {
    return redo_stack_.size();
  }
  [[nodiscard]] std::vector<LayerInfo> layers() const;

  void set_event_sink(EventSink sink) { event_sink_ = std::move(sink); }
  [[nodiscard]] CommandResult execute(const DocumentCommand &command);
  // Transitional shell path: applies a typed command and advances canonical
  // state without retaining a second undo snapshot beside the Qt UI history.
  [[nodiscard]] CommandResult execute_external(const DocumentCommand &command);
  [[nodiscard]] CommandResult undo();
  [[nodiscard]] CommandResult redo();
  [[nodiscard]] SaveResult encode_psd(bool large_document = false) const;
  [[nodiscard]] RenderResult
  render(Rect region, const CancellationToken *cancellation = nullptr) const;
  void mark_saved();
  void mark_external_modified();
  void restore_external(Document document, std::uint64_t state_id);
  void replace_external(Document document, bool saved);

private:
  struct HistoryState {
    Document document;
    std::uint64_t state_id{0};
  };

  static constexpr std::size_t kMaxUndoStates = 40;

  void push_undo_state();
  void prepare_mutation(bool record_history);
  void publish(SessionEventKind kind, LayerId layer_id = 0);
  [[nodiscard]] CommandResult execute_impl(const DocumentCommand &command,
                                           bool record_history);
  [[nodiscard]] CommandResult restore(bool backward);

  Document document_;
  std::vector<HistoryState> undo_stack_{};
  std::vector<HistoryState> redo_stack_{};
  std::uint64_t revision_{0};
  std::uint64_t state_id_{1};
  std::uint64_t saved_state_id_{1};
  std::uint64_t next_state_id_{2};
  EventSink event_sink_{};
};

struct OpenResult {
  std::unique_ptr<DocumentSession> session{};
  SessionError error{};

  [[nodiscard]] explicit operator bool() const noexcept {
    return session != nullptr && !error;
  }
};

[[nodiscard]] OpenResult open_psd(std::span<const std::uint8_t> bytes);

} // namespace patchy::engine
