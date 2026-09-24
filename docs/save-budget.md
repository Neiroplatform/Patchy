# PSD/PSB save-budget contract

Canonical reference for Patchy's output, allocation-free preflight, and tracked
live-workspace guards. Read this before changing a PSD/PSB write path, save-owned
allocation, or save-budget test.

## Public contract and admission order

All `psd::WriteOptions::budget` dimensions are opt-in and default to unlimited.
`SaveUsage` resets at each public write. The public structures and enum values are
append-only.

Admission order is:

1. canvas pixels;
2. logical source pixel bytes;
3. effective layer records;
4. conservative channel-record slots;
5. dynamic tracked-live reservations in algorithm order;
6. final output growth in algorithm order.

Preflight fields update only after their dimension is admitted. Final-output usage
updates incrementally. A tracked-live rejection is carried through compatibility
fallbacks by a private non-`std::exception` signal and translated to
`SaveBudgetExceeded(TrackedLiveBytes)` only at the public boundary.

`WriteOptions{true}` retains its meaning because new fields follow
`large_document`. Appending fields changes by-value ABI and breaks structured
bindings over the aggregates: clean-rebuild every consumer instead of mixing old
and new objects.

## Exact final stream

`max_logical_output_bytes` guards exact final PSD/PSB bytes. The writer charges
before each final vector growth. An exact `N`-byte limit succeeds with usage `N`;
`N-1` throws `SaveBudgetExceeded(LogicalOutputBytes)`. Rejected usage is the
admitted prefix and never exceeds the limit.

The file APIs serialize completely before opening the destination, so a budget
rejection leaves an existing file byte-identical and does not create an absent
path. This is not an atomic-save guarantee: short-write, disk-full, flush, close,
and replacement safety remain separate work.

## Allocation-free preflight

Preflight guards exact canvas pixels, logical source `PixelBuffer` bytes, physical
layer records in the effective normalized graph, and a conservative reservation of
physical channel-record slots.

Source bytes count every logical buffer occurrence in the caller's layer tree:
layer pixels, raster-mask pixels, Smart Filter mask pixels, vector fill/stroke
caches, vector-mask caches, and saved document-channel pixels. Shared allocation
identity is not deduplicated. Preserved flat-composite caches, pattern tiles, Smart
Object payloads, and generated normalization/compositor/encoding/serialization
buffers are excluded.

Layer records include both records for every effective folder, the synthetic
empty-document pixel record, and records introduced by compound-vector and
multi-open-stroke normalization. The preflight simulates that graph without
cloning or rasterizing. Channel records include the RGB composite, one possible
merged-alpha slot, saved document channels, and effective per-layer channels.
Merged alpha and derived vector-mask planes are data-dependent, so admitted usage
may exceed emitted records by one merged-alpha slot and by one slot per qualifying
non-empty derived vector mask whose paths cancel to empty coverage. An empty path
does not reserve a slot. This is not exact post-render channel usage.

The Photoshop 8000-record format error precedes configurable admission. Other later
encoder-format errors may be preceded by an earlier finite preflight rejection.

## DP-008A through DP-008B4a tracked live workspace

`max_tracked_live_bytes` caps conservative logical reservations for instrumented
save-owned temporary buffers. `SaveUsage::tracked_live_bytes` is current
ownership-coupled usage and always unwinds to zero after public success or failure.
`tracked_live_bytes_high_water` is its monotonic per-write maximum. Recursive
layered writes share one tracker and do not reset it.

The current implemented slices cover:

- top-level composite RGB and alpha planes;
- the sequential compositor target and alpha-quantization envelope;
- planar RGB staging;
- PackBits row storage, count tables, row temporaries, and assembled candidates;
- per-channel extraction buffers and RAW fallback copies;
- retained `EncodedChannel` payloads;
- top-level `layer_info` and `layer_mask` writers;
- the per-record `extra` writer and its nested mask, layer-id, section-divider,
  vector-origination-version, protection, mask-effects, interior-effects, and
  channel-restriction writers;
- payload copies parsed from a valid preserved image-resource section;
- generated resolution, grid/guide, ICC-copy, channel-name/identifier/display,
  palette, compound-vector, saved/work-path, and clipping-path payloads;
- the final rebuilt image-resource stream returned to the flat or layered
  document writer;
- generated and copied document-global Smart Filter `FEid`/`FXid` payloads;
- generated document-global pattern payloads and transparent missing-pattern
  placeholder pixels;
- copied, generated, and surgically rebuilt document-global Smart Object
  `lnk*`/`Lnk*` payloads, including normalized embedded PSD/PSB bytes.
- generated and preserved native adjustment-layer payloads for `levl`, `curv`,
  `hue2`, `post`, `thrs`, `brit`, `CgEd`, and `blnc` (`nvrt` is empty).

RAW and RLE candidates count together while both are live. Retained encoded
channels remain charged until their owners die. Copying `layer_info` into
`layer_mask` counts both sections. PackBits reserves a deterministic safe row bound
before the encoder allocates. The final returned stream stays outside this
dimension because `max_logical_output_bytes` guards it independently.

The nested writer reservation is acquired before every buffer growth and remains
live while its bytes are copied into the enclosing record. Returned internal byte
buffers transfer their reservation with the storage; the public PSD serializer
ABI is unchanged. DP-008B2a applies that same owner-coupled rule to the final
image-resource stream, so its reservation overlaps the enclosing `layer_mask`
where those owners are simultaneously live. DP-008B2b removes the redundant
whole-section save copy and couples each parsed payload copy to its storage; a
replace, erase, or reorder therefore releases or transfers the same reservation.
The preserved raw section remains caller-owned DP-006 document state, not save
workspace. A zero-allocation validity pass preserves malformed-section fallback
before any parsed-payload admission. DP-008B2c couples every generated or copied
image-resource payload to a pre-allocation reservation. Direct writers eliminate
the UTF-16 name, display-record, compound-entry, and path-record byte temporaries;
the compound resource uses a count/write traversal. The save-time path deletion
check now mirrors parser acceptance without constructing a `VectorPath`, so a
declared knot count cannot allocate geometry merely to decide whether an absent
modeled path should remove its old resource. Path reorder vectors and resource
container/string capacity remain the platform-dependent bookkeeping exclusions
described below. DP-008B3a copies an original `FEid`/`FXid` block only after
admission and writes regenerated records directly into an owner-coupled tracked
buffer. Unchanged record spans and rekeyed id/tail spans are streamed without a
per-record body copy. All filter payload owners retain the historical eager
lifetime and ordering while they overlap the growing global layer section; this
keeps malformed-input precedence and emitted bytes unchanged while accounting
the actual peak.
DP-008B3b writes authored `Patt` records directly into one owner-coupled tracked
buffer. UTF-16 names use a checked two-pass writer, channel planes stream through
a fixed stack chunk, and the returned payload stays charged while it is copied
into the global layer section. Preserved raw `Patt`/`Pat2`/`Pat3` payloads remain
caller-owned; their copied bytes are already part of the tracked `layer_mask`.
Generated 1x1 transparent placeholders reserve their four pixel bytes before
allocation and keep that reservation coupled to the pixel owner through emission.
Referenced resources that cannot be represented by the pattern codec now fail
closed instead of leaving a dangling pattern id.
DP-008B3c streams fresh embedded/external link elements and surgical wrapper
rebuilds directly into one owner-coupled block payload. It validates embedded
PSD/PSB composite normalization without allocating row tables or row copies,
then writes the normalized file into one tracked buffer. Every normalized
embedded-file occurrence stays charged until the containing link block is
complete, and every completed link block stays charged through the historical
eager link-before-filter build and stable global emission. Caller-owned source
files, original element wrappers, and preserved original block payloads remain
document state; any save-owned copy is charged before allocation. The public
vector-returning codec and emitted bytes remain unchanged.
DP-008B4a gives every non-empty native adjustment-layer payload an
owner-coupled reservation before its final or preserved byte buffer is
allocated. The owner overlaps the growing per-record `extra` writer only while
the additional layer block is copied, then releases before the next block.
`brit` releases before optional `CgEd`, preserving their sequential lifetime.
The `hue2` patch path keeps its 100-byte generated header charged while the
preserved payload copy is admitted, and writes fresh tails into the same header
buffer instead of retaining the old redundant header copy. Existing
vector-returning helpers remain unlimited compatibility wrappers; emitted bytes,
block order, raw-preservation decisions, and malformed fallbacks are unchanged.
The S1 per-layer completion extends the same contract to `luni`, generated
`lfx2`, every generated `TySh` path, vector fill/mask/origination/stroke
payloads, patched preserved `iOpa`, and dirty `SoLd`/`SoLE`/`PlLd` payloads.
The internal serializers return move-only tracked buffers while their existing
vector-returning APIs remain unlimited wrappers. `luni` accounts its exact
UTF-16 arithmetic scratch before allocation. `lfx2` additionally reserves the
normalized gradient-stop copies and a conservative stable-sort envelope.
`TySh` owns template UTF-16 search bytes, the template decode envelope, authored
EngineData, and the final payload; an odd first candidate is released before
EngineData is extended and rebuilt. Each layer payload is released immediately
after it is copied into the tracked `extra` writer, so payloads from later
families and layers are sequential rather than cumulative. Placed-layer budget
signals remain outside `std::exception`, while ordinary parse failures still
fall back to the original caller-owned block. Emitted block order, padding,
descriptor patching, malformed fallbacks, public APIs, and PSD/PSB bytes remain
unchanged. Imported vector and `SoLd`/`SoLE` patch paths conservatively reserve
the original descriptor payload size while the parsed descriptor and generated
output overlap. This covers unbounded contiguous `tdta`/`alis` `raw_value` bytes;
custom `vogk` raw descriptors use the same envelope during coverage validation
and retain it through emission. Descriptor nodes and string storage remain
excluded as documented below.

The S2 completion closes the remaining normalization and renderer workspace with
an allocation-free source census in `psd_save_workspace.hpp`. Before compound-
vector/open-stroke normalization starts, it reserves separate logical owners for
the returned document clones/generated RGBA caches and for vector-raster scratch.
The scratch reservation is released as soon as normalization returns; the clone
owner remains live through the recursive layered write and therefore overlaps the
real compositor/serializer lifetime. The clone envelope counts three logical
copies of caller pixel owners and of every value-owned contiguous vector copied
by `Document`/`Layer` normalization (including raw image resources, global-mask
bytes, blending ranges, unknown-block payloads, style arrays, channel records,
and saved-path geometry). Shared backing stores, strings, map nodes, and
allocator capacity remain excluded. Generated children additionally reserve
their vector-model storage, three overlapping fill/stroke RGBA cache pairs per
generated vector paint, and 96 bytes per canvas pixel for each generated vector
paint while rasterization is active.

The allocation-free census also derives a geometry envelope from every source
path. Straight segments contribute one edge and cubic segments conservatively
contribute the rasterizer's maximum 256 flattened edges. The envelope includes
polyline/dash-run points, direction arrays, outline edges, edge bucket tables,
the 262144-boundary-per-subpath dash fallback, and the platform-sized group-run
owner allocated even for one-anchor subpaths that produce no edges. Join and cap
factors mirror the rasterizer's bevel/miter/round fan limits. This geometry term
is added both to normalization scratch for every generated paint and to renderer
scratch for every vector shape/mask, so a tiny canvas with hostile anchor, group,
or dash complexity cannot pass a canvas-only reservation. Multi-paint shapes
also reserve each recursive single-part model copy and the retained part rasters.

Before the sequential save compositor allocates, the same census reserves a
document-derived renderer envelope. It sums nesting-sensitive group targets,
clipping planes, raster/vector masks, vector raster/paint/stroke workspaces,
Blend-If/adjustment snapshots, Curves model/LUT scratch, and 192 bytes for every
pixel in each enabled distance/blur/stroke/bevel/satin effect's expanded mask
domain. Each domain starts at the larger of the canvas or source/render bounds
and adds the exact/conservative family apron (radius, offset, choke, stroke,
soften, or Satin tent support), so a 1x1 document with a size-100 Outer Glow
reserves its 205x205 domain rather than 192 bytes. Saturating dimension math
rejects an unrepresentable envelope before renderer allocation. Curves reserves
three complete four-channel owner sets at the public nineteen-point-per-channel
limit; that covers metadata decode/return/copy overlap and dominates the
normalized points plus two double-vector workspaces used by one LUT build.
Interior layer effects reserve one exact platform-sized prepared value for every
source Pattern, Gradient, or Color overlay before the renderer filters disabled
or unresolved entries, so overlay cardinality is not hidden behind canvas area.
The same rule covers every source Satin slot reserved by
`prepared_satins.reserve`, including disabled/transparent entries; this owner is
the exact platform `PreparedSatin` size and is separate from enabled mask domains.
Summing enabled effects is intentionally conservative even though the current
renderer normally evaluates them sequentially; this keeps the contract safe if
prepared masks later overlap. The existing exact five-byte-per-pixel target/alpha
envelope remains separate. Both reservations precede the covered allocations and
unwind through the private budget signal on every exit.

Per-layer plane terms follow the active render domain rather than blindly using
the document canvas. A styled group can isolate and retain its recursive
`layer_render_bounds` outside that canvas; its group target, silhouette, and all
child mask/vector/snapshot planes are therefore charged against the larger safe
recursive envelope. The census reproduces that envelope with signed-64-bit
coordinate unions plus saturating style padding, without allocating or invoking
the renderer's `int` geometry arithmetic. Every styled group also reserves the
exact platform-sized `LayerBoundsOverride` vector value retained across the
recursive isolated-layer pass.
Channel-restricted pixel/group layers additionally contribute one logical byte
per source layer for the nested `ChannelRestrictedTarget` mask vector; summing
siblings is conservative, while recursive groups cover the true simultaneous
depth.

A layer-empty layered save is another retained-clone path: the writer copies the
document, inserts one synthetic 1x1 RGBA layer, and recursively serializes it.
The first call therefore reserves the value-owned document clone plus the
synthetic `Layer` and four-byte pixel owner, retaining that reservation through
the recursive write just like a vector-normalization clone.

## Explicit exclusions and completed DP-008B boundary

The implemented slices are not a complete process-memory limit. They exclude allocator capacity
slack, container nodes and strings, stack/runtime overhead, OS/file buffers,
third-party internals, caller source storage, and final output storage.

Contiguous byte and arithmetic planes, row/count tables, and serializer payloads
are in scope when their allocation sites are instrumented. STL node/capacity
overhead, descriptor-tree nodes, and string storage remain explicitly outside the
logical-byte contract; normalization must use a documented logical envelope for
those excluded structures rather than claim allocator-exact accounting.

DP-008B is complete after S2 for save-owned contiguous byte/arithmetic planes,
normalization clones, generated raster caches, and the compositor workspaces
listed above. The final source census is maintained in
`psd_save_workspace.hpp`; adding a new save-reachable normalization or renderer
temporary requires extending that census and the whole-gate fixture in the same
change.

Product callers must not treat DP-008A as a complete save-memory ceiling. Finite
values and caller wiring remain downstream policy work after DP-008B and
native/WASM calibration.

## Required tests

Preflight regressions cover flat/layered PSD and PSB, mixed RGB/RGBA/mask/group/
adjustment/saved-channel input, empty recursion, compound-vector and open-stroke
normalization, fixed admission order, usage reset, and rejection before an otherwise
unsupported encoder path. Source audit, rather than a runtime allocator hook, proves
that the preflight uses scalar counters and read-only traversal only.

Tracked-live regressions pin reservation overlap, sequential reuse, move/release and
overflow behavior, exact compositor-plane census above and below the automatic
parallel threshold, deterministic RAW/RLE and extra-channel lifetimes, flat/layered
PSD/PSB exact-fit, one-short and zero limits, recursive normalization, byte equality,
usage reset/unwind after typed and ordinary encoder failures, format/preflight/output
precedence, unchanged writer canary, and destination preservation. DP-008B1 pins
the aggregate `extra` plus restrictions peak at 210 bytes and the pre-change direct
record at 232 bytes/FNV-1a `60f80b960fca3de1`, then proves exact, one-short, zero,
byte-equality, and unwind behavior. Separate minimal records make the layer-id,
returned section-divider, protection, mask-effects, interior-effects, and
restriction overlaps observable above their enclosing `extra` owner. The shared
tracked-writer primitive has a direct returned-buffer lifetime test; earlier
mask-data and vector-origination-version sites are additionally source-audited
because later mandatory record bytes dominate their local overlap in high-water.
DP-008B2a pins the minimal rebuilt image-resource stream at 28 bytes/FNV-1a
`89d7e6821196bcad`, proves that its reservation survives the helper return, and
checks exact, one-short, zero, overlap, byte-stability, and unwind behavior. Flat
and layered PSD/PSB high-water canaries include the returned stream while it is
copied into the final output. DP-008B2b pins a 36-byte preserved input whose
parsed payload owners total 11 bytes and whose rebuilt stream is 48 bytes/FNV-1a
`dd749d5efe02bc9d`: replacement releases 3 bytes before the surviving 8 overlap
the final stream. DP-008B2c adds the generated 16-byte resolution owner, changing
that peak from 56 to 72 and the minimal 28-byte stream peak from 28 to 44. A
32-byte replaced resolution fixture peaks at 48, proving replacement is not
released before its successor is admitted. The combined grid/ICC/channel/palette/
compound fixture pins 138 live payload bytes plus a 262-byte rebuilt stream (400
peak). Path coverage pins 52-byte records, a 7-byte clipping selector, the 16-byte
resolution payload, and the 112-byte rebuilt stream (187 peak), plus the 160-byte
clean relocated-path-copy peak. One-short, parser-stage, zero, and
malformed-tail cases prove rejection, unwind, admission-before-copy, and the
allocation-free validator's byte-preserving parity for opaque malformed paths.
DP-008B3a pins the 20-byte unchanged `FEid` payload at FNV-1a
`71386559776f89b4`, the same-size rekeyed payload at `5976b3c78a774ddb`,
and the 3-byte original-payload copy at `160a9e188e7e3df9`. Direct exact,
one-short, zero, staged-overlap, malformed-unwind, and public byte-equivalence
checks accompany a two-block layered fixture. Its 4096-byte `FEid` and 2048-byte
`FXid` copies produce a 13384-byte tracked peak after the retained synthetic-
layer clone reservation and prove exact, one-short, and typed pre-copy rejection
while both eager owners remain live.
DP-008B3b pins opaque, transparent, two-record, Unicode, and 4097-pixel chunk
payloads at 244, 272, 488, 248, and 12532 bytes, with direct exact/N-1/zero,
staged/concurrent ownership, invalid-skip, and unwind checks. Minimal authored and
placeholder layered files peak at 1592 and 1652 bytes. A four-block
`Patt`/`Pat2`/`Pat3` fixture preserves raw order and a valid prefix before a
malformed tail, deduplicates covered ids, emits one 516-byte generated `Patt`,
and pins the public tracked peak at 2044 bytes with exact and typed N-1 rejection.
DP-008B3c pins odd embedded PSD and PSB normalization at 64 and 74 bytes
(FNV-1a `f3cf2b65da3eda5d` and `6fef8cec82673920`), the 184-byte authored `liFD` payload at
`9d12c9f317164ada`, the 496-byte external `liFE` payload at
`7713bac86f810fc4`, and the unchanged seven-byte original block at
`496ef57bd256f9d5`. The authored block peaks at 258 bytes while its 74-byte
normalized owner overlaps the growing final payload; two source occurrences
sharing that same embedded owner peak at 516, proving no pointer-identity
deduplication. A foreign-wrapper rebuild peaks at 254 and retains its trailer.
A two-link plus `FEid`
public fixture is 1070 bytes/FNV-1a `9a03676658d006f7` and pins the complete
eager owner/global-copy peak at 3364 bytes after the retained synthetic-layer
clone reservation. Direct and public exact/N-1/zero,
owner-release, typed unwind, allocation-free invalid/already-compliant
normalization, and Smart Object semantic wrapper tests cover the slice.
DP-008B4a pins fresh `levl`, `curv`, `hue2`, `post`, `thrs`, `brit`, `CgEd`,
and `blnc` payload bytes and hashes with direct exact/N-1/zero admission and
unwind. A 4096-byte preserved `hue2` payload peaks at 4196 bytes while its
100-byte generated header overlaps the admitted copy, preserving the opaque
tail byte-for-byte. Raw-copy and malformed-fallback fixtures cover `curv`,
`post`, `brit`, `CgEd`, and `blnc`; staged `levl` plus `blnc` owners prove
release and non-deduplicated overlap. The public adjustment fixture is 4359
bytes/FNV-1a `3cfe5cfb993ec789` and pins an 8619-byte tracked peak with exact,
typed N-1, zero, and unwind-to-zero checks.
The S1 per-layer completion adds direct exact/N-1/zero/unwind coverage for
Unicode `luni`; gradient-fill and gradient-stroke `lfx2` including noise,
empty-stop normalization, and sort scratch; authored, same-length imported-
template, malformed-template, and no-match `TySh`; generated, preserved, and
patched vector fill/stroke/origination plus non-empty mask and staged owners;
dirty `SoLd`/`SoLE` and both `PlLd` spellings; and malformed placed fallback.
The authored `TySh` case has an internal branch trace that proves its odd first
candidate is released and rebuilt with EngineData padding. A single staged
layer-record regression writes two text layers through one tracker, proves the
first record returns current usage to zero before the second begins, then proves
two copies of the same source span are charged concurrently and release
independently rather than being pointer-deduplicated.
An isolated four-byte patched `iOpa` test proves its owner overlaps the enclosing
`extra` reservation. The combined public fixture contains base, text/style,
patched `iOpa`, live vector fill/mask/stroke/origination, a matching global
Smart Object source plus dirty placed layer, and a native adjustment layer; both
formats reopen and verify these semantics.
On non-Windows hosts its PSD canary is 11440 bytes/FNV-1a
`a46a8dbbd3169900`; PSB is 12424 bytes/FNV-1a `74b0d895c5bb7ad7`.
Windows resolves the authored Arial run to the system PostScript name `ArialMT`,
so its deterministic native canaries are 11448 bytes/FNV-1a
`e3f3e0d4d890c0dc` for PSD and 12432 bytes/FNV-1a `06509563506089eb`
for PSB. On the macOS Release ABI all four cases have a 417600-byte tracked
peak after the S2 geometry census. Other native/WASM ABIs derive the peak from
the 415648-byte scalar baseline plus the exact shared Curves, prepared-overlay,
and path-group value sizes; every platform requires exact
success, byte-identical repeat serialization, typed N-1/zero rejection, and
zero current usage after success or unwind. Existing text, vector, Smart Object,
fill-opacity, and layered-writer canaries remain
unchanged. The integration test also materializes those exact bytes as
`test-artifacts/s1-generated-layer-payloads.psd` and `.psb` for the external
Photoshop gate. They are published through verified temporary files only after
both formats pass every assertion; the `.manifest` file is written last from
the actual accepted platform bytes and is the acceptance marker. These files
are test evidence, not checked-in fixtures.

The S2 whole-gate fixture combines nested groups, a clipping chain, raster and
vector masks, compound vectors, an open multi-subpath live vector stroke that
normalizes to native children, and concurrent drop-shadow, large outer-glow,
stroke, bevel, and satin families. On the macOS Release libc++ ABI its clone/
geometry-complete census pins 290972 owner bytes, 949424 normalization-scratch
bytes, 6565056 pre-normalization renderer bytes, and a 7273100-byte public peak
after normalization changes the effective graph. Windows and WASM retain exact
success/N-1 admission but report their ABI-derived logical owner sizes instead
of pretending libc++ container value sizes are portable. Sequential normalized rendering pins
FNV-1a `501ebd773ac1f3bc`; reopened rendering pins `47648a1ddc27a07b`.
The same complete graph is also rendered on a 2000x2000 canvas through
Automatic and explicit Sequential policies; their bytes must match, crossing
the 4M-pixel strip-parallel threshold on multi-core native/WASM runners.
The PSD is 11720 bytes/FNV-1a `a90e17b0e1df7606`; the PSB is 12660 bytes/FNV-1a
`a6eecbb0a2011eb3`. Both formats require repeat-byte equality, semantic reopen,
exact success, typed N-1/zero rejection, and unwind to zero.
Emitted PSD/PSB and render hashes remain unchanged. A separate hostile fixture
puts 128 anchors on a tiny canvas, proves
that both normalization and renderer reservations scale with geometry, verifies
that dash fallback increases both envelopes, and requires exact/N-1/unwind
behavior through the public writer. Its companion marked-group fixture carries
large raw image-resource, blending-range, and unknown-block payloads and proves
that their value-owned clone bytes are admitted before normalization allocation.
The same hostile fixture puts four maximum nineteen-point curves on a one-pixel
document, pins the fixed model scratch independently of canvas area, and repeats
the public exact/N-1/zero/unwind proof plus a targeted compositor-prefix +
renderer-reservation exact/N-1/zero boundary. It also combines 128 one-anchor shape-group
runs with 128 enabled Color overlays and 128 disabled Satins on a one-pixel
canvas and proves all three platform-sized owner terms at the same targeted
boundary. A separate size-100 Outer Glow pins the 205x205 expanded domain and
its targeted/public exact/N-1/zero admission. A 1x1 document containing a
256x256 off-canvas styled group independently pins recursive group/silhouette
planes and descendant domains at the same targeted/public boundary. A plain
one-pixel channel-restricted layer pins its otherwise owner-only one-byte
renderer reservation at targeted/public exact/N-1/zero. A layer-empty document
with a large raw image-resource vector independently covers the retained
synthetic-layer clone path at its owner-reservation exact/N-1/zero boundary.

Every later save-workspace accounting site needs admission before allocation, an owner-coupled
reservation that survives returned buffers, exact/N-1/zero tests, unwind-to-zero
proof, overlap rather than cumulative-sum proof, and unlimited byte-stability. The
Photoshop warning-free gate remains separate and must report whether it actually ran.
