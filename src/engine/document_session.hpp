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

struct SetLayersVisibility {
  std::vector<LayerId> layer_ids{};
  bool visible{true};
};

struct LayerLockState {
  LayerId layer_id{0};
  LayerLockFlags flags{kLayerLockNone};
};

struct SetLayerLockStates {
  std::vector<LayerLockState> layers{};
};

struct SetLayerClipping {
  LayerId layer_id{0};
  bool clipped{false};
};

struct SetLayerMaskState {
  LayerId layer_id{0};
  std::optional<LayerMask> mask{};
  bool linked{true};
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

// Publishes the final result of an interactive selection gesture. The shell may
// preview marquee/lasso/wand/Quick Select geometry while the pointer is down,
// but the canonical commit succeeds only if the engine still owns the exact
// pre-gesture selection. This prevents a late gesture completion from
// overwriting a newer selection command.
struct CommitPreparedSelection {
  SelectionSnapshot before{};
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

struct SetVectorMaskState {
  LayerId layer_id{0};
  std::optional<LayerVectorMask> mask{};
};

struct RasterizeVectorMask {
  LayerId layer_id{0};
};

struct AddVectorShapeLayer {
  std::string name{};
  VectorShapeContent content{};
  PatternStore patterns{};
  std::optional<LayerId> anchor_layer_id{};
  std::optional<LayerMask> mask{};
};

struct UpdateVectorShapeLayer {
  LayerId layer_id{0};
  VectorShapeContent content{};
  PatternStore patterns{};
};

struct VectorShapeLayerState {
  LayerId layer_id{0};
  VectorShapeContent content{};
};

struct VectorMaskLayerState {
  LayerId layer_id{0};
  LayerVectorMask mask{};
};

// Publishes one already-previewed direct-canvas edit as a single canonical
// engine mutation. The Qt shell owns the transient mouse-move preview and its
// history snapshot; this command validates and re-bakes every final layer
// state atomically, then advances the shared state identity exactly once.
struct CommitVectorLayerStates {
  std::vector<VectorShapeLayerState> shapes{};
  std::vector<VectorMaskLayerState> masks{};
  PatternStore patterns{};
  // Union accumulated while transient preview frames mutated the shared
  // document. The final state alone cannot reconstruct vacated old bounds.
  Rect preview_affected_region{};
};

struct PreviewedLayerState {
  LayerId layer_id{0};
  Layer layer{};
};

// Publishes the final state of one already-previewed shell transaction. The Qt
// shell owns interactive transform/paint frames and its UI history; the engine
// validates the complete target set and advances canonical state exactly once
// at the completion boundary.
struct CommitPreviewedLayerStates {
  std::vector<PreviewedLayerState> layers{};
  Rect preview_affected_region{};
  // Nondestructive appearance commits may adopt pattern resources together
  // with the prepared layer state. Interactive pixel/transform completions
  // leave this empty and preserve the canonical store.
  std::optional<PatternStore> patterns{};
};

// Publishes one already-previewed saved-channel edit as a single canonical
// engine mutation. Interactive frames may update the shared COW channel in the
// Qt shell, but only this completion command advances session identity/dirty.
struct CommitPreviewedDocumentChannel {
  ChannelId channel_id{0};
  DocumentChannel channel{};
  Rect preview_affected_region{};
};

// Publishes a complete document prepared by a host-side operation whose
// semantics span the layer tree and document resources (Smart Objects, paths,
// merges and rasterization). The expected state identity prevents an async or
// dialog-prepared result from replacing a newer canonical edit. Canvas-sized
// geometry is deliberately immutable here; resize/crop/rotate retain their
// narrower validated command families.
enum class PreparedDocumentMutationKind : std::uint8_t {
  Text,
  SmartObject,
  Path,
  MergeRasterize,
};

struct CommitPreparedDocumentState {
  PreparedDocumentMutationKind kind{PreparedDocumentMutationKind::SmartObject};
  std::uint64_t expected_state_id{0};
  Document document{};
  Rect affected_region{};
};

// Saved-channel structure and metadata are canonical document state too. These
// commands keep the desktop Channels panel and non-Qt engine consumers on the
// same validation, history and revision boundary.
struct AddDocumentChannel {
  DocumentChannel channel{};
};

struct RemoveDocumentChannel {
  ChannelId channel_id{0};
};

struct RenameDocumentChannel {
  ChannelId channel_id{0};
  std::string name{};
};

struct ReorderDocumentChannels {
  std::vector<ChannelId> channel_ids{};
};

struct InvertDocumentChannel {
  ChannelId channel_id{0};
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
                 SetLayersOpacity, SetLayersFillOpacity, SetLayersBlendMode,
                 SetLayersVisibility, SetLayerLockStates, SetLayerClipping,
                 SetLayerMaskState, UngroupLayers, FlipLayers, PlaceLayers,
                 ReplaceLayerPixels, ApplyFilter, SetSelection,
                 CommitPreparedSelection,
                 ModifySelection, SelectLayerAlpha, SelectLayerMask,
                 SelectLayerVectorMask, SelectSmartFilterMask,
                 SelectByColorSimilarity, SelectVectorPath,
                 TransformVectorLayers, SetVectorMaskState,
                 RasterizeVectorMask, AddVectorShapeLayer,
                 UpdateVectorShapeLayer, CommitVectorLayerStates,
                 CommitPreviewedLayerStates,
                 CommitPreviewedDocumentChannel,
                 CommitPreparedDocumentState,
                 AddDocumentChannel, RemoveDocumentChannel,
                 RenameDocumentChannel, ReorderDocumentChannels,
                 InvertDocumentChannel,
                 CommitSmartFilterState>;

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
  PreviewStarted,
  PreviewUpdated,
  PreviewEnded,
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
  std::optional<Rect> affected_region{};
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

struct OperationProgress {
  // Return false to cancel. completed/total are monotonic work rows.
  std::function<bool(std::int32_t completed, std::int32_t total)> update{};
};

enum class SavePhase : std::uint8_t {
  Started = 0,
  Normalizing = 1,
  Compositing = 2,
  EncodingLayers = 3,
  Serializing = 4,
  Complete = 5,
};

struct SaveOperationProgress {
  // Return false to cancel. Bytes are exact and monotonic once serialization
  // starts; phase is monotonic across a normal layered save.
  std::function<bool(SavePhase phase, std::uint64_t logical_output_bytes)>
      update{};
};

struct RenderResult {
  PixelBuffer pixels{};
  Rect region{};
  std::uint64_t revision{0};
  SessionError error{};

  [[nodiscard]] explicit operator bool() const noexcept { return !error; }
};

struct SessionMemoryUsage {
  std::size_t document_pixel_bytes{0};
  std::size_t history_pixel_bytes{0};
  std::size_t preview_pixel_bytes{0};
  std::size_t selection_bytes{0};
  std::size_t history_selection_bytes{0};
  std::size_t preview_selection_bytes{0};
  std::size_t history_retained_bytes{0};
  std::size_t total_retained_bytes{0};
  std::size_t undo_states{0};
  std::size_t redo_states{0};
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
  [[nodiscard]] const Document *undo_document(std::size_t index) const noexcept;
  [[nodiscard]] const Document *redo_document(std::size_t index) const noexcept;
  [[nodiscard]] const SelectionSnapshot *undo_selection(
      std::size_t index) const noexcept;
  [[nodiscard]] const SelectionSnapshot *redo_selection(
      std::size_t index) const noexcept;
  [[nodiscard]] std::vector<LayerInfo> layers() const;
  [[nodiscard]] bool preview_active() const noexcept {
    return preview_state_.has_value();
  }
  [[nodiscard]] std::optional<Rect> pending_render_region() const noexcept {
    return pending_render_region_;
  }
  [[nodiscard]] std::optional<Rect> take_pending_render_region() noexcept;
  [[nodiscard]] SessionMemoryUsage memory_usage() const;

  void set_event_sink(EventSink sink) { event_sink_ = std::move(sink); }
  [[nodiscard]] CommandResult
  execute(const DocumentCommand &command,
          const FilterProgress *filter_progress = nullptr);
  // Transitional shell path: applies a typed command and advances canonical
  // state without retaining a second undo snapshot beside the Qt UI history.
  [[nodiscard]] CommandResult
  execute_external(const DocumentCommand &command,
                   const FilterProgress *filter_progress = nullptr);
  // Transitional desktop previews mutate the session-owned document without
  // advancing canonical revision/state/dirty identity. The engine retains the
  // exact pre-preview document and selection, emits preview-only events and
  // restores that baseline before the accepted typed command is executed.
  [[nodiscard]] CommandResult begin_preview();
  [[nodiscard]] CommandResult update_preview(Rect affected_region = {},
                                             LayerId layer_id = 0);
  [[nodiscard]] CommandResult end_preview();
  [[nodiscard]] CommandResult undo();
  [[nodiscard]] CommandResult redo();
  [[nodiscard]] SaveResult
  encode_psd(bool large_document = false,
             const CancellationToken *cancellation = nullptr,
             const SaveOperationProgress *progress = nullptr) const;
  [[nodiscard]] RenderResult
  render(Rect region, const CancellationToken *cancellation = nullptr,
         const OperationProgress *progress = nullptr) const;
  void mark_saved();
  void mark_external_modified();
  // Transitional shell edits capture their pre-edit COW snapshot asynchronously
  // and transfer ownership here. Qt retains labels only; document/selection
  // history has a single canonical owner.
  void push_external_undo_state(Document document, std::uint64_t state_id,
                                SelectionSnapshot selection = {});
  void clear_history() noexcept;
  [[nodiscard]] bool evict_oldest_undo() noexcept;
  void trim_undo(std::size_t keep) noexcept;
  void clear_redo() noexcept;
  void restore_external(Document document, std::uint64_t state_id,
                        SelectionSnapshot selection = {});
  void replace_external(Document document, bool saved);

private:
  struct HistoryState {
    Document document;
    SelectionSnapshot selection{};
    std::uint64_t state_id{0};
  };

  struct PreviewState {
    Document document;
    SelectionSnapshot selection{};
  };

  static constexpr std::size_t kMaxUndoStates = 40;

  void push_undo_state();
  void prepare_mutation(bool record_history);
  void publish(SessionEventKind kind, LayerId layer_id = 0,
               std::optional<Rect> affected_region = std::nullopt);
  void schedule_render(std::optional<Rect> affected_region) noexcept;
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
  std::optional<PreviewState> preview_state_{};
  std::optional<Rect> pending_render_region_{};
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
