# Fast Search for VS Code

Fast Search is a standalone, local-only VS Code extension for low-latency filename and full-text search. A persistent Rust sidecar owns indexing and matching; the extension uses only stable VS Code APIs. The interaction is inspired by the speed and shape of Zed search, but all Fast Search code is independently written.

## Features and support

- **Fast Search: Open File** (`fastSearch.openFile`) provides fuzzy, whitespace-atom filename search. Append `:line` or `:line:column` to jump to a location.
- **Fast Search: Find in Files** (`fastSearch.findInFiles`) opens a dedicated activity-bar view with literal/regex, case, whole-word, include/exclude, ignore-setting, progress, cancellation, and grouped results.
- **Fast Search: Rebuild Index** (`fastSearch.rebuildIndex`) atomically replaces the current snapshots.
- **Fast Search: Show Diagnostics** (`fastSearch.showDiagnostics`) shows engine readiness, indexed-file count, roots, generation, and failures.

Version 1 supports trusted, local `file:` workspaces on macOS arm64 and x86_64. It does not support remote workspaces, Linux, Windows, replacement, rich notebook content, symbols, or Marketplace publishing. No proposed VS Code API is used.

## Install and shortcuts

Build or download the VSIX, then run **Extensions: Install from VSIX…**. Fast Search deliberately does not replace built-in shortcuts. Add this exact JSON to `keybindings.json` if desired:

```json
[
  { "key": "cmd+p", "command": "fastSearch.openFile" },
  { "key": "cmd+shift+f", "command": "fastSearch.findInFiles" }
]
```

The filename picker fuzzy-matches the normalized full relative path and ranks filename prefixes, short paths, and files near the active editor more highly. Empty input includes open editors and recent choices; selecting previews, Enter pins, and the split button opens beside. The search view accepts comma-separated include/exclude globs, retains workspace-local query history, and renders large result sets in bounded windows. Text search supports literal and regular-expression modes, smart-case, explicit case sensitivity, whole words, multiline expressions, LF/CRLF, UTF-8 BOMs, configured `files.encoding`, binary rejection, and dirty or untitled editor overlays. Ignore files and resource-scoped `files.exclude` are honored by default; disabling exclusions performs a query-specific walk while still applying the view's explicit exclusions.

Settings:

- `fastSearch.filePicker.maxResults` — `100` by default.
- `fastSearch.filePicker.preserveInput` — inherits `search.quickAccess.preserveInput` when unset.
- `fastSearch.logging.level` — `error`, `warn`, `info`, or `debug`; default `warn`.

The first scan is cold and proportional to the workspace tree. Roots become searchable as they finish, and watcher events captured during the scan are replayed before readiness. Warm filename queries operate on an in-memory snapshot; text search still reads candidate contents in parallel and streams bounded batches. The release targets are native filename-search p95 ≤25 ms, command-to-visible p95 ≤50 ms, first partial results ≤250 ms, cancellation acknowledgement ≤50 ms, and ≤300 MiB RSS for one million average paths. On the development arm64 Mac, the checked benchmark currently measures about 9 ms filename p95, 179 MiB peak RSS, an 8 ms first content batch, and about 1 ms cancellation acknowledgement. End-to-end UI timing remains a release-machine measurement, not a universal filesystem claim.

## Architecture

```text
VS Code composition root
├── File picker feature ──┐
├── Search view feature ──┼── EngineClient ── NDJSON ── Rust engine
├── Configuration adapter ┤                         ├── Workspace index
└── Editor adapter ───────┘                         ├── Filename matcher
                                                    └── Text searcher
```

`src/extension` only composes lifecycle. `src/filePicker` and `src/searchView` own presentation and never spawn processes or import one another. `src/configuration` translates VS Code settings. `src/engine` owns process lifetime, validation, request routing, stale IDs, restart, and shutdown. Rust crates proceed inward from protocol DTOs to index snapshots to search algorithms; only the executable coordinates requests and transport. See `docs/architecture.md`.

## Development

Prerequisites are macOS, Node.js 26.8.2+, pnpm, Rust 1.98+, Xcode command-line tools, `cargo-deny`, `cargo-about`, and `@vscode/vsce` from the lockfile.

The repository pins pnpm 12.4.1. Install the license tools with `cargo install cargo-deny --locked` and `cargo install cargo-about --locked --features cli` if they are not already available.

```sh
pnpm install --frozen-lockfile
pnpm run test:integration       # native black-box protocol flow first
pnpm run test:extension         # packaged-sidecar extension-host flow
pnpm run test:unit              # focused TypeScript and Rust units
pnpm run typecheck
pnpm run format:check
pnpm run lint:native
pnpm run build
pnpm run benchmark
pnpm run licenses
pnpm run package
```

Run one native test with `cargo test --manifest-path native/Cargo.toml -p fast-search-engine --test engine_protocol <name>` and one TypeScript test with `pnpm exec vitest run test/unit/protocol.test.ts`. `scripts/build-universal.sh` builds both Apple targets and combines them with `lipo`; packaging must never substitute a host-only binary.

For an unsupported workspace, open a trusted local folder. If results appear stale, run **Rebuild Index**. If the engine exits unexpectedly, it is restarted once and reinitialized; a second failure stops it. Open **Show Diagnostics** for stderr and state. A release candidate must also be installed into stock VS Code and manually checked for shortcuts, keyboard/ARIA navigation, themes, indexing progress, and crash recovery.

## Privacy, licensing, and contributing

All indexing and search execute locally. There is no telemetry or network service. Paths and contents are never transmitted; only paths and compact index metadata live in memory, and file contents are not persisted.

Original code is MIT licensed. Unmodified `nucleo-matcher` is MPL-2.0; ripgrep search components and other dependencies retain their permissive licenses. See `THIRD_PARTY_NOTICES.md`. If MPL-covered source is modified, the modified covered files must remain available under MPL-2.0. This project contains no Zed or VS Code implementation code, fixtures, CSS, icons, or branded artwork.

Contributions should preserve dependency direction, add behavior at its owning boundary, keep protocol changes mirrored and versioned, and put each semantic behavior in one integration suite. Do not mechanically translate GPL-covered Zed code.
