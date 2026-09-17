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

## DP-008A tracked live workspace

`max_tracked_live_bytes` caps conservative logical reservations for instrumented
save-owned temporary buffers. `SaveUsage::tracked_live_bytes` is current
ownership-coupled usage and always unwinds to zero after public success or failure.
`tracked_live_bytes_high_water` is its monotonic per-write maximum. Recursive
layered writes share one tracker and do not reset it.

The current DP-008A slice covers:

- top-level composite RGB and alpha planes;
- the sequential compositor target and alpha-quantization envelope;
- planar RGB staging;
- PackBits row storage, count tables, row temporaries, and assembled candidates;
- per-channel extraction buffers and RAW fallback copies;
- retained `EncodedChannel` payloads;
- top-level `layer_info` and `layer_mask` writers.

RAW and RLE candidates count together while both are live. Retained encoded
channels remain charged until their owners die. Copying `layer_info` into
`layer_mask` counts both sections. PackBits reserves a deterministic safe row bound
before the encoder allocates. The final returned stream stays outside this
dimension because `max_logical_output_bytes` guards it independently.

## Explicit DP-008A exclusions and DP-008B

DP-008A is not a complete process-memory limit. It excludes allocator capacity
slack, container nodes and strings, stack/runtime overhead, OS/file buffers,
third-party internals, caller source storage, and final output storage.

DP-008B remains open for:

- compound/open-stroke normalization clones and vector-raster scratch;
- deep compositor group, clipping, style, effect, distance-field, and blur planes;
- nested layer-record and resource writers;
- rebuilt image-resource streams;
- generated Smart Object, Smart Filter, and pattern serialization payloads.

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
precedence, unchanged writer canary, and destination preservation.

Every later DP-008B accounting site needs admission before allocation, an owner-coupled
reservation that survives returned buffers, exact/N-1/zero tests, unwind-to-zero
proof, overlap rather than cumulative-sum proof, and unlimited byte-stability. The
Photoshop warning-free gate remains separate and must report whether it actually ran.
