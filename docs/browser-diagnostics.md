# Browser support diagnostics

The self-hosted editor can create a local, privacy-safe diagnostic JSON from
the **Diagnostics** action. Opening the dialog shows the exact exclusion policy;
the file is created only after the user checks the consent control and selects
**Download diagnostic JSON**. The editor performs no upload and has no telemetry
endpoint.

## Data contract

Schema `patchy.browser-diagnostics@1` contains only:

- coarse browser/platform families and capability booleans;
- bucketed device memory and hardware concurrency;
- engine capability bits and UI locale;
- anonymous document width, height, layer/open-document/selection counts,
  revision, dirty flag and aggregate retained/history bytes;
- at most 256 typed Worker lifecycle, command outcome, recovery and classified
  error events with monotonic session-relative time.

It never contains document/layer/asset names, text, pixels, previews, source
bytes, content-derived hashes, file paths, URLs, user-agent/version strings,
stack traces or error messages. Event producers cannot attach arbitrary fields;
the same strict schema is applied again before serialization. Bundles larger
than 128 KiB fail closed.

## Offline validation

Support validates a user-supplied file without opening the source document:

```sh
node scripts/validate-browser-diagnostics.mjs patchy-diagnostics.json
```

Exit `0` prints a bounded summary. Exit `1` means the schema, bounds, event
ordering or size is invalid; no partial summary is emitted. Exit `2` means the
command was invoked incorrectly. Treat the file as user-provided diagnostic
data even though the format excludes editor content.

The actual-browser recovery gate uses an installed Playwright package without
making it a product dependency:

```sh
PATCHY_PLAYWRIGHT_ROOT=/path/to/node_modules/playwright \
  node tests/sdk/wasm_diagnostics_recovery_smoke.mjs http://127.0.0.1:8974
```

It drives the production pthread-WASM shell through create/edit/failure,
forces the exact engine Worker to crash, waits for confirmed OPFS recovery,
downloads the consent-gated bundle and accepts it only through the offline
validator. It authors an editable text story and imports a PNG whose decoded
RGBA channels carry a deterministic marker; those real text/pixel values plus
the private filename/layer name and crash message must be absent from the
downloaded bytes.

## Compatibility and rollback

Readers reject unknown schema versions and fields. A future additive format
therefore requires a new version and an explicit reader update. Removing the
browser feature changes no engine ABI, PSD/PSB bytes, OPFS workspace or document
state; previously downloaded JSON remains inert.
