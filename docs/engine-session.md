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
- `CommitPreparedSelection` is the completion boundary for every interactive
  marquee/lasso/wand/Quick Select/Magnetic Lasso/move/nudge/Quick Mask gesture.
  Pointer frames remain responsive in Canvas, but release commits only when the
  canonical selection still matches the pre-gesture baseline. Semantic region
  comparison accepts equivalent Qt rectangle decompositions after undo/redo;
  stale completions are rejected and Canvas is resynchronized from the engine;
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
- `CommitPreviewedLayerStates` is the atomic completion boundary for desktop
  gestures whose transient frames still mutate the Qt-owned document. Free
  Transform/Warp and raster content/mask painting record their UI undo snapshot
  without independently dirtying the session, then publish the complete final
  layer set once. The command validates stable IDs/tree topology, preserves all
  layer payloads, reports accumulated old/new dirty bounds and advances one
  engine state identity. Transform commits include linked mask riders; paint
  commits cover Brush/Eraser/Mixer/Pattern Stamp/Clone/Healing/local adjustment/
  Smudge, Fill, Gradient, raster Shape, Spot Healing and Patch completion. The
  same boundary can atomically adopt a prepared document pattern store for
  accepted layer-style edit/paste/delete state while ordinary gesture commits
  leave resources untouched;
- `SetLayersVisibility`, `SetLayerLockStates`, `SetLayerClipping` and
  `SetLayerMaskState` own the remaining nondestructive layer protection,
  compositing and raster-mask lifecycle. Multi-layer commands validate the
  entire target set before mutation; clipping validates its effective base and
  invalidates both participants; mask add/delete/link/enable/invert validate
  geometry, preserve off-canvas imported bounds, report old/new effect bounds
  and round-trip through PSD with one revision and undo state;
- `SetLayerStylePreset` applies or clears a deterministic built-in style by
  stable preset id. It validates every referenced built-in pattern before the
  mutation, adopts those resources into the document, invalidates imported
  native style blocks and reports the union of old/new effect bounds in one
  undoable revision;
- `CommitPreviewedDocumentChannel` is the matching atomic completion boundary
  for saved alpha-channel gestures. Canvas keeps responsive brush/fill frames,
  accumulates their bounded dirty union and records one transitional UI undo
  snapshot without dirtying the session; release publishes the exact final
  channel once after validating stable ID/kind and full-canvas gray8 geometry.
  Quick Mask already completes through `SetSelection`, while Smart Filter mask
  edits complete through `CommitSmartFilterState`; all three specialized paths
  therefore advance exactly one canonical revision per accepted gesture;
- `AddDocumentChannel`, `RemoveDocumentChannel`, `RenameDocumentChannel`,
  `ReorderDocumentChannels` and `InvertDocumentChannel` own the remaining
  saved-channel lifecycle. They validate full-canvas gray8 payloads, channel
  limits, editable Alpha targets, complete unique order and fixed Spot-channel
  positions before committing one revision/history state. Desktop New, Save
  Selection, Rename, Reorder, Invert and Delete all use these commands, while
  PSD encode/reopen preserves the resulting names, order, kinds and pixels;
- `CommitPreparedDocumentState` publishes operations whose final state spans
  both the layer tree and document resources. It requires the exact state
  identity from which the result was prepared, rejects stale async/dialog
  completions, preserves canvas geometry/format, validates layer/channel/path
  identities and constrains Work/Clipping Path roles before one atomic commit.
  Desktop text completion, embedded/linked Smart Object lifecycle, saved/work
  path CRUD plus Fill/Stroke Path, and merge/rasterize now finish through this
  boundary. Stroke Path suppresses its per-substroke completion callbacks and
  publishes the entire scripted stroke as one revision/history state;
- `CommitSmartFilterState` atomically commits a UI-prepared supported Smart
  Filter stack or removal: modeled stack/mask state, regenerated SoLd/SoLE
  payloads, FEid/FXid cache store and rendered layer pixels share one validated
  state identity, dirty region and undo step. Desktop add/edit/toggle/mask/
  duplicate/reorder/delete flows use this boundary after preview preparation;
- `AddAdjustmentLayer` and `UpdateAdjustmentLayer` own creation and final
  edits for all eight supported nondestructive adjustment kinds. Engine-side
  layer-ID allocation, optional selection mask, native payload regeneration,
  full-canvas dirty bounds, semantic no-op detection, undo and PSD reopen all
  share one Qt-free command family. Final desktop commits use this boundary;
- `begin_preview` / `update_preview` / `end_preview` make transient dialog
  rendering session-owned without making a preview a committed edit. The
  session snapshots the exact document and committed selection at begin,
  publishes preview-only events while parameters are scrubbed, and restores
  the baseline before the accepted typed command. Revision, state identity,
  dirty state and history remain unchanged throughout; commands, undo/redo and
  PSD encoding fail closed until the preview ends. Adjustment-layer create/edit,
  editable Smart Filter dialogs and both plain-layer and Smart Object Filter
  Gallery canvas previews use this lifecycle, including asynchronous latest-wins
  renders and cancellation;
- every successful mutation gets a new state identity and a monotonic revision;
  rejected and no-op commands change neither;
- render-affecting commands publish their exact `affected_region` and coalesce
  it into one session-owned pending render region until the consumer takes it.
  Consecutive disjoint edits therefore schedule one union, while metadata-only
  renames/channel operations and transient preview events do not enqueue a
  canonical repaint. Document geometry, complex layer-tree placement,
  external replacement and undo/redo conservatively invalidate the complete
  current canvas;
- undo and redo restore document state identities, so returning to the saved
  state clears dirty even after intervening edits;
- `memory_usage()` reports the session's retained document, undo/redo, preview
  and selection memory. Pixel storage is counted once across COW-sharing state;
  selection container/mask ownership is reported conservatively per snapshot.
  The desktop history budget consumes this engine-owned census instead of
  walking canonical snapshots from Qt;
- `layers()` exposes a flat stable-ID projection for non-Qt clients;
- `render` returns a bounded RGBA8 region tied to the session revision. The
  compositor clips directly to that document-space region and allocates only
  the region-sized RGBA8 output, including the document-alpha preservation
  path. Callers can request monotonic row progress; progressive rendering runs
  in bounded horizontal bands, preserves byte-for-byte parity with one-shot
  compositing and checks cancellation between bands. Callback cancellation
  returns no partial pixel buffer and never changes document state;
- `encode_psd` writes layered PSD bytes and accepts a cancellation token plus a
  phase/output-byte progress callback. Cancellation is checked before
  normalization, compositing, layer encoding and each committed serialization
  write; it returns `Cancelled` with no partial byte vector. Successful
  progressive output stays byte-identical to one-shot encoding. `mark_saved`
  remains separate so a cancelled or failed filesystem write cannot falsely
  clear dirty state;
- errors cross the boundary as `SessionError`, not Qt dialogs or C++ pointers.

`engine/host_protocol.h` is the first private pre-1.0 browser-host ABI. A host
must negotiate `PATCHY_ENGINE_HOST_PROTOCOL_VERSION` before opening a session;
opaque runtime/session handles, fixed-width command/event envelopes, inline
diagnostics and explicitly released output buffers keep C++ objects and
exceptions behind the boundary. Version 1 reports capabilities and now exposes
both opened PSD and new RGBA8 document sessions; complete document identity,
geometry, format, history and dirty projection; plus flat layer-tree projection
with parent, kind, name, bounds, appearance, locks and clipping state. Every
mutating envelope carries the exact expected document state identity, so a
stale browser command fails before it reaches the model. The envelope now also
requires the exact revision, preventing a late command from overwriting newer
selection/history state that deliberately shares a document state ID. Browser hosts can add
solid layers and groups, remove/move/ungroup them, edit visibility/name/opacity/
fill/blend/locks/clipping or apply/clear a built-in layer-style preset, resize
image/canvas, rotate or crop, then render,
undo/redo, encode layered PSD and acknowledge durable persistence separately.
The save acknowledgement is also state-guarded, so bytes from an older state
cannot clear the dirty flag of a newer edit. The protocol also projects and
authors canonical rectangular selections, and projects committed soft masks,
saved channels and complete document-path knots. It accepts bounded RGBA8 layer
add/replace payloads, full-canvas alpha-channel payloads and solid-fill/stroke
vector shapes, while selection morphology, channel CRUD/reorder/load and path
CRUD/reorder/clipping/select commands reuse the same canonical engine history.
Raster-mask metadata/pixels and add/disable/invert/remove lifecycle, plus
parameterized destructive filters, cross the same revision-and-state guarded
boundary. Filters consume canonical committed selection instead of a second
UI-owned region. Render, PSD encode and filter execution
expose C callbacks for cooperative progress/cancellation; cancellation returns
a typed error, publishes no partial output and does not advance canonical
state. Each session also drains engine events through a fixed-capacity FIFO:
events retain their command/selection/preview/history/save kind, revision,
state identity, dirty flag, affected layer and dirty region, while an explicit
dropped counter makes a slow browser consumer observable without allocating
inside the engine event callback.
Browser-authored text accepts editable UTF-8 text/font/style metadata together
with the host-rasterized RGBA preview that remains the committed reference
pixels. Browser text updates retain stable layer identity, rebuild the editable
metadata/reference raster in one prepared-document commit and round-trip
through undo/redo and PSD reopen. Editable RGBA8 layer pixels can be exported
through an owned buffer and atomically replaced with new pixels/bounds for one-
commit paint and transform gestures. Embedded and linked Smart Objects accept
the same bounded preview plus
either immutable source bytes or explicit external URI/absolute/relative link
metadata. Both families commit through the stale-safe prepared-document
boundary, project their editable/source identity back to the host and preserve
stable layer IDs, embedded bytes, link kind and composite pixels through PSD
save/reopen. Replacing embedded content preserves the layer ID, appearance and
Smart Filter stack in one undoable commit. Embedded bytes can be exported without exposing C++ ownership;
linked sources deliberately expose metadata only and never read host paths.
The browser host can now create or update all eight modeled adjustment-layer
kinds, author/remove vector masks with path, density, feather and mask flags,
and apply a supported single-entry Smart Filter stack to an editable embedded
Smart Object. The initial Smart Filter authoring subset is Gaussian Blur, High
Pass, Median, Mosaic and Box Blur; the engine renders the committed pixels and
regenerates both placed-layer and filter-cache PSD metadata in the same atomic
command. Projection APIs return adjustment parameters/curve points,
vector-mask shape counts and Smart Filter kind/value without exposing C++
ownership.
Core contract fixtures execute `open → inspect → render → mutate → undo → redo
→ save → reopen`, `create → author layers/tree/geometry → render → save-ack →
reopen`, `upload pixels → select → author channel/path/vector → save → reopen`
and `upload → mask → filter → progress/cancel → drain events → save → reopen`
plus `text → embedded/linked Smart Objects → project/export → save → reopen`
and `pixels → vector mask → adjustment → embedded Smart Object → Smart Filter
→ render → save → reopen`
in every native or wasm-core build, and the header is valid strict C11.

The build recursively rejects any Qt target in `patchy_engine`'s dependency
tree and rejects Qt includes in the public engine facade at configure time. A
negative CMake fixture proves the guard fails closed, so native, Windows and
WASM configurations enforce the same boundary.

## Browser Worker SDK

`sdk/engine` is the first private browser binding for the C ABI. The client
transfers an owned copy of input bytes to one Dedicated Worker, correlates
typed requests and rejects every pending request if the Worker traps or message
decoding fails. The Worker alone owns the Emscripten runtime and active session;
it exposes `open`/`create`, document/layer/selection/mask/text projections,
layer, text, shape/vector-mask, adjustment and embedded Smart Object authoring,
replacement and Smart Filters, image/canvas geometry, canonical selection,
raster masks, one-commit RGBA paint/transform, selected-area filtering,
undo/redo, render and layered PSD save. Canonical document state never enters
the UI process. Filter cancellation is a main-thread `SharedArrayBuffer`
flag sampled by the C progress callback while the Worker is synchronously in
Wasm, so cancellation remains responsive without concurrent session access.
The same one-owner path now covers selection-aware solid/gradient fills,
one-gesture Clone/Heal commits, numeric rectangle-anchor shape edits and an
atomic RGBA8 plus linked raster-mask transform. Unlinked or unsupported masked
transforms still fail closed.
Channels and saved/work paths project into the browser snapshot; selection can
be saved as an alpha channel or rectangular path and restored from either.
Invert/expand/contract/border selection plus layer fill opacity, lock flags and
clipping reuse the guarded command envelope and canonical undo history. The
same path applies the six browser-exposed built-in style recipes without
moving layer-style ownership into JavaScript.

The `wasm-sdk` preset builds a no-entry ES module named `patchy-engine.mjs`.
Its checked export manifest contains only allocator functions and the C ABI
surface used by the binding. `wasm_sdk_main.cpp` pins every wasm32 structure
size and offset consumed by JavaScript, including geometry commands and filter
inputs, so an Emscripten ABI-layout change fails the build instead of
corrupting projections. Node contract tests cover
the complete Worker workflow, transferable input ownership, output-buffer
release, export closure and explicit crash state. The actual Emscripten build
remains a required hosted gate when the pinned toolchain is available.

The same preset stages `build/wasm-sdk/site`, a dependency-free self-hosted
editor shell. It closes the browser product loop from open/drop or blank
creation through layered PSD download plus flattened PNG/JPEG/WebP/SVG export.
The screen can import decoded RGBA8 PNG/JPEG/WebP/AVIF/SVG pixels as layers,
open a dropped raster image as a new document, and keep up to 16 isolated
switchable document sessions inside the same Worker. Document tabs activate or
close those engine sessions without moving canonical state into the UI. Rendered
pixels travel through the browser clipboard between open documents; copy
preserves the exact committed soft selection as alpha and keeps an in-memory
fallback when system clipboard permission is unavailable. The screen can also
apply built-in layer-style, gradient, pattern and font presets, then
select/remove/group/ungroup/reorder/rename layers and edit
visibility, opacity and common blend modes before undo/redo and render. Every
document can also be scaled, canvas-resized around the center, rotated or
cropped. A shared command registry drives toolbar and keyboard actions; the
canvas adds fit/zoom/pan, rulers and marquee selection. Selected pixels support
invert plus brush/eraser; pixel or text layers support direct move/numeric free
transform, and editable text can be created/restyled from a browser-rasterized
reference. Raster masks can be added, disabled, inverted or removed. Every
completed gesture crosses the
revision/state-guarded Worker RPC; the shell never owns a second selection or
document state. Masked-layer transform is deliberately refused until linked
mask geometry can commit atomically. Empty, busy, drop, engine-error and Worker-crash states remain
explicit. Download completion deliberately does not acknowledge durable save
because the browser cannot prove the file was kept.

The self-hosted shell also maintains a versioned OPFS recovery store without
uploading document bytes. Each open document has an opaque local workspace id.
Its per-document queue snapshots the owning Worker session, serializes writes,
and coalesces superseded pending revisions. Alternating PSD and manifest slots
publish only after byte-count and SHA-256 verification, so discovery chooses
the newest complete generation and can fall back to the prior generation after
a torn or corrupt write. The Recovery dialog validates, lists, restores and
explicitly deletes isolated workspaces and exposes browser quota, unavailable
storage and write-failure states. Closing a tab retains its confirmed local
snapshot; page reload opens recovered PSD bytes in a new Worker session.
Recovery preserves the layered document represented by PSD. In-memory undo
history and transient, non-dirty selection state remain session-local and are
not represented as durable recovery data.

## Desktop transition

The Qt shell now stores its canonical document, committed selection and all
undo/redo Document/Selection snapshots inside `engine::DocumentSession`. The
canvas keeps only the transient Qt projection needed while a gesture is in
flight; direct selection commands use `SetSelection`, while interactive
gesture release crosses `CommitPreparedSelection` with stale-result rejection.
Qt history stacks retain presentation-only labels and stable row
IDs at the matching engine indices. Direct shell mutations transfer their
asynchronously captured pre-edit COW snapshot with
`push_external_undo_state`, then execute a typed completion command; the legacy
`mark_external_modified` adapter remains only for command families outside this
slice.
Layer-panel create/group/ungroup/delete/reorder, visibility, lock, clipping,
raster-mask lifecycle, layer-style final state, rename, opacity/fill/blend and
flip workflows, plus canvas-resize/rotation, already execute through typed
engine commands. The scripting API shares those commands
for core layer add/remove/group/reorder, principal layer properties and
destructive filters. Desktop crop-to-selection, expanding/rotated crop and tile
seam shifting, plus scripted crop, now share typed geometry commands and the
canonical selection reset. Desktop destructive-filter and Auto All commits
cross the same typed pixel boundary after their existing preview/progress workflow. Selection
snapshots cross the desktop history boundary as a Qt-free engine value with
explicit retained-byte accounting. Undo, redo, multi-step history jumps,
New-Document-From-State, background Smart Object commits, selection coalescing,
global cross-session memory eviction and stress trimming all operate on the
single engine-owned snapshot stacks. Partial repaint still diffs the pre-hop
COW document against the restored canonical document. `execute_external`
prevents transitional shell workflows that already transferred a snapshot from
retaining a hidden duplicate. Direct text, Smart Object, document-path and
merge/rasterize completion no longer advances revision/dirty state directly in
MainWindow; remaining unrelated shell mutations migrate by command family.

New headless consumers must use typed commands. New Qt workflows should use
typed commands when their operation is covered; adding new direct state owners
or a second dirty/revision counter is forbidden.

## Remaining M2 boundary

- run the versioned host sequence under the supported wasm-core/Qt-WASM
  toolchain and compare its event/projection/output contract with native;
- keep the private host protocol pre-1.0 while the remaining cohesive desktop
  command families migrate and hosted parity evidence is collected;
- migrate remaining unrelated direct shell mutations by cohesive command
  family while keeping desktop, scripting and browser hosts on one model;
- complete Windows/WASM, corpus, Photoshop and independent review gates before
  promoting this private ABI or the product gitlink.
