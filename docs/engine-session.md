# Engine document session

`patchy_engine` is the Qt-free application boundary being extracted from the
desktop shell. `engine::DocumentSession` owns the canonical `Document`, state
identity, monotonic revision, dirty state, committed selection and the first
typed editing commands.

## Current contract

- `open_psd` creates a session without `QApplication` or Qt types.
- `execute` supports singular and atomic multi-layer visibility,
  opacity/fill/blend, rename, add/remove/group/ungroup/reorder/flip lifecycle,
  image/canvas geometry, clipped or expanding/rotated crop, wrap-offset seam
  transforms, atomic pixel replacement and parameterized destructive filters.
  Crop and wrap commands reset committed selection atomically, while seam
  parity metadata travels with the same undoable document mutation. Filter
  commands accept Qt-free document-space selection rectangles, report dirty
  bounds and reject cancellation without changing history.
- `SetSelection` commits a Qt-free region/mask/Quick Mask snapshot. Selection
  changes advance revision and participate in undo/redo, but retain the current
  document state identity and therefore do not make the file dirty;
- `ModifySelection` owns Select All, Deselect, Invert and square-radius
  Expand/Contract/Border morphology without Qt geometry. Desktop Select menu
  and scripting select-all/deselect project the resulting canonical snapshot
  back to Canvas instead of running a second UI algorithm;
- `SelectLayerAlpha`, `SelectLayerMask`, `SelectLayerVectorMask` and
  `SelectSmartFilterMask` derive hard and soft selection coverage from the
  canonical layer state. Select > Load Layer Transparency, layer context-menu
  selection and Ctrl-clicks on content/raster-mask/vector-mask/Smart-Filter-mask
  thumbnails all execute these commands and project the same undoable snapshot;
- `SelectByColorSimilarity` owns contiguous Grow and document-wide Similar
  selection against the canonical flattened pixels, while `SelectVectorPath`
  owns path rasterization, anti-aliasing, feather and replace/add/subtract/
  intersect semantics. Desktop menu/Paths panel and scripting share these
  commands;
- `TransformVectorLayers` owns atomic Qt-free affine transforms for one or
  several shape/vector-mask layers, including rerasterization, stroke scaling,
  dirty bounds and undo. Scripting shape and vector-mask transforms use this
  command instead of replacing the session document directly;
- `SetVectorMaskState` and `RasterizeVectorMask` own the committed vector-mask
  lifecycle: add/edit/enable-disable/remove/rasterize, cache regeneration,
  raster-mask composition, PSD block invalidation, semantic no-op detection,
  dirty bounds and undo. Desktop commands and scripting use this shared path;
- `AddVectorShapeLayer` and `UpdateVectorShapeLayer` own authored shape-layer
  creation and semantic updates, including stable ID allocation, pattern-store
  adoption, native block invalidation, rerasterization, bounded dirty output,
  optional selection masks, no-op detection, undo and PSD reopen. Desktop
  Shape/Line/Polygon/Custom/Pen creation, boolean extension, fill-layer
  creation and final appearance/live-geometry commits share this path with
  scripting add/fill/update; dialog scrubbing remains transient shell preview;
- `CommitVectorLayerStates` is the atomic completion boundary for direct-canvas
  point editing. Anchor/handle drag frames remain a bounded shell preview, but
  mouse release and discrete add/delete/convert/nudge/combine/path-transform
  commits snapshot every affected shape/vector-mask layer, validate the whole
  set, re-bake it and advance one shared engine state identity. Cross-layer
  Direct Select therefore publishes one mutation rather than one command per
  layer, while the transitional desktop history keeps exactly one snapshot;
- `CommitTransformedLayerStates` is the atomic completion boundary for desktop
  Free Transform and Warp. Interactive resampling/proxy frames remain in the
  Qt canvas, but single-layer, folder and multi-selection commits snapshot the
  complete final target set (including linked mask riders), validate stable
  IDs/topology, report accumulated old/new dirty bounds and advance one engine
  state identity. The host records its UI undo snapshot without independently
  dirtying the session, so transform completion is one canonical mutation;
- `CommitSmartFilterState` atomically commits a UI-prepared supported Smart
  Filter stack or removal: modeled stack/mask state, regenerated SoLd/SoLE
  payloads, FEid/FXid cache store and rendered layer pixels share one validated
  state identity, dirty region and undo step. Desktop add/edit/toggle/mask/
  duplicate/reorder/delete flows use this boundary after preview preparation;
- `AddAdjustmentLayer` and `UpdateAdjustmentLayer` own creation and final
  edits for all eight supported nondestructive adjustment kinds. Engine-side
  layer-ID allocation, optional selection mask, native payload regeneration,
  full-canvas dirty bounds, semantic no-op detection, undo and PSD reopen all
  share one Qt-free command family. Dialog previews remain a transient shell
  projection and final desktop commits use this boundary;
- every successful mutation gets a new state identity and a monotonic revision;
  rejected and no-op commands change neither;
- undo and redo restore document state identities, so returning to the saved
  state clears dirty even after intervening edits;
- `layers()` exposes a flat stable-ID projection for non-Qt clients;
- `render` returns a bounded RGBA8 region tied to the session revision. The
  compositor clips directly to that document-space region and allocates only
  the region-sized RGBA8 output, including the document-alpha preservation
  path; cancellation is checked before and after compositing;
- `encode_psd` writes layered PSD bytes, while `mark_saved` is separate so a
  failed filesystem write cannot falsely clear dirty state;
- errors cross the boundary as `SessionError`, not Qt dialogs or C++ pointers.

## Desktop transition

The Qt shell now stores its canonical document and committed selection inside
`engine::DocumentSession`. The canvas keeps only the transient Qt projection
needed while a gesture is in flight; each completed desktop or scripting
selection operation crosses `SetSelection`. Its existing history stacks remain
a temporary adapter while their stored values are already Qt-free. Direct shell
mutations use `mutable_document` together with `mark_external_modified`, and
history restore uses `restore_external` with the recorded engine state identity
and selection.
Layer-panel create/group/ungroup/delete/reorder, visibility, rename,
opacity/fill/blend and flip workflows, plus canvas-resize/rotation, already
execute through typed engine commands. The scripting API shares those commands
for core layer add/remove/group/reorder, principal layer properties and
destructive filters. Desktop crop-to-selection, expanding/rotated crop and tile
seam shifting, plus scripted crop, now share typed geometry commands and the
canonical selection reset. Desktop destructive-filter and Auto All commits
cross the same typed pixel boundary after their existing preview/progress workflow. Selection
snapshots cross the desktop history boundary as a Qt-free engine value with
explicit retained-byte accounting. Undo, redo, history jumps, background smart
object commits and script selection setters all restore or read the same engine
value instead of recapturing a second canonical state from a canvas.
`execute_external` prevents that transitional path from retaining a hidden
second undo snapshot beside UI history. The remaining MainWindow mutations
migrate by command family.

New headless consumers must use typed commands. New Qt workflows should use
typed commands when their operation is covered; adding new direct state owners
or a second dirty/revision counter is forbidden.

## Remaining M2 boundary

- move the remaining in-flight gesture selection algorithms behind the engine
  boundary (committed ownership, menu morphology, similarity, path and all
  layer-thumbnail-derived selections are already there);
- migrate remaining brush/pixel gestures, Smart Filter preview preparation,
  transient adjustment previews and history storage to engine commands;
- add command families for remaining nondestructive filters/adjustments;
- add progress-aware cancellation inside long render/save operations;
- keep the desktop shell and scripting API on the same command path.
