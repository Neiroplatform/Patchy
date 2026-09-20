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
- every successful mutation gets a new state identity and a monotonic revision;
  rejected and no-op commands change neither;
- undo and redo restore document state identities, so returning to the saved
  state clears dirty even after intervening edits;
- `layers()` exposes a flat stable-ID projection for non-Qt clients;
- `render` returns a bounded RGBA8 region tied to the session revision and
  accepts a cancellation token;
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

- move transient selection gesture algorithms themselves behind the engine
  boundary (committed ownership and history are already there);
- migrate remaining brush/pixel, vector, Smart Filter and adjustment mutations,
  plus history storage, to engine commands;
- add command families for pixel transforms and remaining nondestructive
  filters/adjustments;
- add progress-aware cancellation inside long render/save operations;
- replace full-document flattening in `render` with a region compositor;
- keep the desktop shell and scripting API on the same command path.
