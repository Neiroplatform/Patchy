#pragma once

#include "core/document.hpp"
#include "core/adjustment_layer.hpp"
#include "core/layer_tree.hpp"
#include "core/pixel_tools.hpp"
#include "core/smart_filter.hpp"
#include "core/smart_filter_effects.hpp"
#include "filters/filter_registry.hpp"

#include <atomic>
#include <array>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <utility>
#include <variant>
#include <vector>

namespace patchy::engine {

enum class SessionErrorCode {
  None,
  InvalidArgument,
  LayerNotFound,
  CommandFailed,
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

// Qt-free canonical selection value. Regions are stored as non-overlapping
// document-space rectangles; an optional gray8 mask preserves soft edges.
struct SelectionSnapshot {
  std::vector<Rect> selection{};
  std::vector<Rect> display_region{};
  Rect mask_bounds{};
  PixelBuffer mask_alpha{};
  std::optional<PixelBuffer> quick_mask_pixels{};

  [[nodiscard]] bool empty() const noexcept { return selection.empty(); }
  [[nodiscard]] std::size_t retained_bytes() const noexcept;
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

struct SetLayerFillOpacity {
  LayerId layer_id{0};
  float opacity{1.0F};
};

struct SetLayerBlendMode {
  LayerId layer_id{0};
  BlendMode blend_mode{BlendMode::Normal};
};

struct SetLayersOpacity {
  std::vector<LayerId> layer_ids{};
  float opacity{1.0F};
};

struct SetLayersFillOpacity {
  std::vector<LayerId> layer_ids{};
  float opacity{1.0F};
};

struct SetLayersBlendMode {
  std::vector<LayerId> layer_ids{};
  BlendMode blend_mode{BlendMode::Normal};
};

struct AddPixelLayer {
  std::string name{};
  PixelBuffer pixels{};
  std::optional<LayerId> anchor_layer_id{};
};

struct AddAdjustmentLayer {
  std::string name{};
  AdjustmentSettings settings{};
  std::optional<LayerMask> mask{};
};

struct UpdateAdjustmentLayer {
  LayerId layer_id{0};
  AdjustmentSettings settings{};
};

struct AddGroup {
  std::string name{};
  std::vector<LayerId> grouped_layer_ids_top_to_bottom{};
};

struct UngroupLayers {
  std::vector<LayerId> group_ids{};
};

enum class FlipAxis { Horizontal, Vertical };

struct FlipLayers {
  std::vector<LayerId> layer_ids{};
  FlipAxis axis{FlipAxis::Horizontal};
};

struct RemoveLayers {
  std::vector<LayerId> layer_ids{};
};

struct ResizeImage {
  std::int32_t width{0};
  std::int32_t height{0};
};

struct ResizeCanvas {
  std::int32_t width{0};
  std::int32_t height{0};
  CanvasAnchor anchor{CanvasAnchor::Center};
  EditColor extension_color{255, 255, 255, 255};
};

struct RotateCanvas {
  double clockwise_degrees{0.0};
  EditColor extension_color{255, 255, 255, 255};
};

struct CropDocument {
  Rect crop{};
  double clockwise_degrees{0.0};
  EditColor extension_color{255, 255, 255, 255};
  // Script/API crops retain their historical clamp-to-canvas contract, while
  // the interactive crop tool may deliberately extend beyond the canvas.
  bool clip_to_canvas{false};
};

struct WrapOffsetDocument {
  std::int32_t dx{0};
  std::int32_t dy{0};
  // The tile-preview parity marker is committed atomically with the pixels.
  // A missing value removes the marker after shifting back.
  std::optional<std::string> seam_offset_metadata{};
};

struct MoveLayers {
  std::vector<LayerId> layer_ids_top_to_bottom{};
  std::optional<LayerId> target_layer_id{};
  LayerDropPosition position{LayerDropPosition::OnViewport};
};

struct PlaceLayers {
  // Storage/composite order (bottom to top), matching Document::layers().
  std::vector<LayerId> layer_ids_bottom_to_top{};
  std::optional<LayerId> parent_group_id{};
  std::size_t index{0};
};

struct ReplaceLayerPixels {
  LayerId layer_id{0};
  PixelBuffer pixels{};
  Rect bounds{};
  bool rasterize_smart_object{false};
};

struct ApplyFilter {
  LayerId layer_id{0};
  FilterInvocation invocation{};
  // Empty means the whole layer. Rectangles use document coordinates and are
  // normalized by the caller's selection projection.
  std::vector<Rect> selection{};
};

struct SetSelection {
  SelectionSnapshot selection{};
};

enum class SelectionOperation {
  SelectAll,
  Clear,
  Invert,
  Expand,
  Contract,
  Border,
};

struct ModifySelection {
  SelectionOperation operation{SelectionOperation::Clear};
  std::int32_t pixels{0};
};

struct SelectLayerAlpha {
  LayerId layer_id{0};
};

struct SelectLayerMask {
  LayerId layer_id{0};
};

struct SelectLayerVectorMask {
  LayerId layer_id{0};
};

struct SelectSmartFilterMask {
  LayerId layer_id{0};
};

enum class SelectionSimilarityMode { Grow, Similar };

struct SelectByColorSimilarity {
  SelectionSimilarityMode mode{SelectionSimilarityMode::Grow};
  std::int32_t tolerance{32};
};

enum class SelectionCombineMode { Replace, Add, Subtract, Intersect };

struct SelectVectorPath {
  VectorPath path{};
  double feather{0.0};
  bool antialias{true};
  SelectionCombineMode combine{SelectionCombineMode::Replace};
};

enum class VectorTransformTarget { ShapeAndMask, VectorMaskOnly };

struct TransformVectorLayers {
  std::vector<LayerId> layer_ids{};
  // Row-major 2x3 affine: x' = ax + cy + tx, y' = bx + dy + ty.
  std::array<double, 6> matrix{1.0, 0.0, 0.0, 1.0, 0.0, 0.0};
  double stroke_scale{1.0};
  VectorTransformTarget target{VectorTransformTarget::ShapeAndMask};
};

struct CommitSmartFilterState {
  LayerId layer_id{0};
  std::optional<SmartFilterStack> stack{};
  PixelBuffer rendered_pixels{};
  Rect rendered_bounds{};
  std::vector<std::pair<std::size_t, std::vector<std::uint8_t>>>
      regenerated_blocks{};
  SmartFilterEffectsStore filter_effects{};
};

using DocumentCommand =
    std::variant<SetLayerVisibility, SetLayerOpacity, RenameLayer,
                 SetLayerFillOpacity, SetLayerBlendMode, AddPixelLayer,
                 AddAdjustmentLayer, UpdateAdjustmentLayer,
                 AddGroup, RemoveLayers, MoveLayers, ResizeImage, ResizeCanvas,
                 RotateCanvas, CropDocument, WrapOffsetDocument,
                 SetLayersOpacity, SetLayersFillOpacity,
                 SetLayersBlendMode, UngroupLayers, FlipLayers, PlaceLayers,
                 ReplaceLayerPixels, ApplyFilter, SetSelection,
                 ModifySelection, SelectLayerAlpha, SelectLayerMask,
                 SelectLayerVectorMask, SelectSmartFilterMask,
                 SelectByColorSimilarity, SelectVectorPath,
                 TransformVectorLayers, CommitSmartFilterState>;

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
  SelectionChanged,
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
  LayerId affected_layer_id{0};
  std::optional<Rect> affected_region{};

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
  [[nodiscard]] const SelectionSnapshot &selection() const noexcept {
    return selection_;
  }
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
  [[nodiscard]] CommandResult
  execute(const DocumentCommand &command,
          const FilterProgress *filter_progress = nullptr);
  // Transitional shell path: applies a typed command and advances canonical
  // state without retaining a second undo snapshot beside the Qt UI history.
  [[nodiscard]] CommandResult
  execute_external(const DocumentCommand &command,
                   const FilterProgress *filter_progress = nullptr);
  [[nodiscard]] CommandResult undo();
  [[nodiscard]] CommandResult redo();
  [[nodiscard]] SaveResult encode_psd(bool large_document = false) const;
  [[nodiscard]] RenderResult
  render(Rect region, const CancellationToken *cancellation = nullptr) const;
  void mark_saved();
  void mark_external_modified();
  void restore_external(Document document, std::uint64_t state_id,
                        SelectionSnapshot selection = {});
  void replace_external(Document document, bool saved);

private:
  struct HistoryState {
    Document document;
    SelectionSnapshot selection{};
    std::uint64_t state_id{0};
  };

  static constexpr std::size_t kMaxUndoStates = 40;

  void push_undo_state();
  void prepare_mutation(bool record_history);
  void publish(SessionEventKind kind, LayerId layer_id = 0);
  [[nodiscard]] CommandResult execute_impl(const DocumentCommand &command,
                                           bool record_history,
                                           const FilterProgress *filter_progress);
  [[nodiscard]] CommandResult restore(bool backward);

  Document document_;
  SelectionSnapshot selection_{};
  std::vector<HistoryState> undo_stack_{};
  std::vector<HistoryState> redo_stack_{};
  std::uint64_t revision_{0};
  std::uint64_t state_id_{1};
  std::uint64_t saved_state_id_{1};
  std::uint64_t next_state_id_{2};
  FilterRegistry filter_registry_{};
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
