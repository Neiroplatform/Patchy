# Engine document session

`patchy_engine` is the Qt-free application boundary being extracted from the
desktop shell. `engine::DocumentSession` owns the canonical `Document`, state
identity, monotonic revision, dirty state and the first typed layer commands.

## Current contract

- `open_psd` creates a session without `QApplication` or Qt types.
- `execute` supports singular and atomic multi-layer visibility,
  opacity/fill/blend, rename, add/remove/group/ungroup/reorder/flip lifecycle,
  image/canvas geometry, atomic pixel replacement and parameterized destructive
  filters. Filter commands accept Qt-free document-space selection rectangles,
  report dirty bounds and reject cancellation without changing history.
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

The Qt shell now stores its canonical document inside `engine::DocumentSession`.
Its existing selection-aware history remains a temporary adapter because it
also owns `QRegion` and `QImage` snapshots. Direct shell mutations use
`mutable_document` together with `mark_external_modified`, and history restore
uses `restore_external` with the recorded engine state identity.
Layer-panel create/group/ungroup/delete/reorder, visibility, rename,
opacity/fill/blend and flip workflows, plus canvas-resize/rotation, already
execute through typed engine commands. The scripting API shares those commands
for core layer add/remove/group/reorder, principal layer properties and
destructive filters. Desktop destructive-filter and Auto All commits cross the
same typed pixel boundary after their existing preview/progress workflow. Selection
snapshots cross the desktop history boundary as a Qt-free engine value with
explicit retained-byte accounting; live selection editing is still owned by the
canvas adapter.
`execute_external` prevents that transitional path from retaining a hidden
second undo snapshot beside UI history. The remaining MainWindow mutations
migrate by command family.

New headless consumers must use typed commands. New Qt workflows should use
typed commands when their operation is covered; adding new direct state owners
or a second dirty/revision counter is forbidden.

## Remaining M2 boundary

- move live selection ownership and editing behind the engine boundary;
- migrate remaining brush/pixel, vector, Smart Filter and adjustment mutations,
  plus history storage, to engine commands;
- add command families for pixel selection, transforms and filters;
- add progress-aware cancellation inside long render/save operations;
- replace full-document flattening in `render` with a region compositor;
- keep the desktop shell and scripting API on the same command path.
