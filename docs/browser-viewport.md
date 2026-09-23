# Browser SDK viewport navigation

Read before changing pan, zoom, rulers or browser canvas overlays.

The Qt-free browser editor treats zoom and pan as document-local view state.
`viewport-model.mjs` owns finite zoom bounds, Fit calculation, cursor anchoring,
scroll clamping and deterministic 1/2/5 ruler steps. `editor.mjs` coalesces
wheel, pointer, keyboard, scroll and resize work through one animation-frame
update. Those updates resize and reposition the already committed canvas frame,
guides, selection, transform overlay and rulers. They must not call
`renderFrame`, mutate the engine snapshot or create history.

The privacy-safe `__patchyViewportDiagnostics` assertion surface retains only
timings, counts and the number of tracked document viewports. Closing a document
must remove its viewport entry after the active-session transition completes.
Worker crash recovery clears runtime-id keyed viewport state before restored
sessions receive their new ids.
Rulers are absolute overlay children whose scroll-compensating transform keeps
them at the viewport edges without adding grid tracks or changing canvas
geometry.

`wasm_shell_accessibility_smoke.html` drives the staged pthread-WASM editor in a
real browser. It checks pointer and keyboard navigation, cursor-anchored zoom,
independent state and cleanup across document tabs, checkerboard/ruler geometry,
animation-frame coalescing and zero render requests. Its navigation performance
sample dispatches one zoom event per frame for 60 frames and requires the frame
interval p95 to stay at or below 16.67 ms with no long task, page error or failed
request. Node viewport tests cover math and staging but cannot replace DOM
layout, paint cadence and input evidence.
