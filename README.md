# Fast Search for VS Code

Fast Search is a standalone, local-only VS Code extension for low-latency filename and full-text search. A persistent Rust sidecar owns indexing and matching; the extension uses only stable VS Code APIs.

## Features and support

- **Fast Search: Open File** (`fastSearch.openFile`) provides fuzzy, whitespace-atom filename search. Append `:line` or `:line:column` to jump to a location.
- **Fast Search: Find in Files** (`fastSearch.findInFiles`) opens a dedicated activity-bar view with literal/regex, case, whole-word, include/exclude, progress, cancellation, and collapsible file groups. File headings show the filename, a smaller workspace-relative directory, the remaining match count, and icons from your installed file-icon theme.
- **Fast Search: Rebuild Index** (`fastSearch.rebuildIndex`) atomically replaces the current snapshots.
- **Fast Search: Show Diagnostics** (`fastSearch.showDiagnostics`) shows engine readiness, indexed-file count, roots, generation, and failures.

Version 1 supports trusted, local `file:` workspaces on macOS arm64 and x86_64. It does not support remote workspaces, Linux, Windows, replacement, rich notebook content, symbols, or Marketplace publishing. No proposed VS Code API is used.

## Install and shortcuts

Build or download the VSIX, then run **Extensions: Install from VSIX…**. To build and test your local changes, follow [Install and visually test a local build](#install-and-visually-test-a-local-build). Fast Search deliberately does not replace built-in shortcuts. Add this exact JSON to `keybindings.json` if desired:

```json
[
  { "key": "cmd+p", "command": "fastSearch.openFile" },
  { "key": "cmd+shift+f", "command": "fastSearch.findInFiles" }
]
```

The filename picker fuzzy-matches the normalized full relative path and ranks filename prefixes, short paths, and files near the active editor more highly. Empty input includes open editors and recent choices; selecting previews, Enter pins, and the split button opens beside. The search view accepts comma-separated folders or globs in Files to include, and glob patterns in Files to exclude, retains workspace-local query history, and renders large result sets in bounded windows. Text search supports literal and regular-expression modes, smart-case, explicit case sensitivity, whole words, multiline expressions, LF/CRLF, UTF-8 BOMs, configured `files.encoding`, binary rejection, and dirty or untitled editor overlays. Search always honors resource-scoped `files.exclude` and `search.exclude`, including conditional sibling rules; `search.exclude` overrides duplicate patterns from `files.exclude`. Ignore files follow `search.useIgnoreFiles` (enabled by default), `search.useGlobalIgnoreFiles`, and `search.useParentIgnoreFiles` (both disabled by default). Global and parent ignores require `search.useIgnoreFiles`. Change these standard VS Code settings to include ignored files; the view's explicit exclusions remain additional filters.

Search results follow the native file-list layout. Click a file heading to collapse
or expand its matches. Hover or focus a row to reveal its dismiss action; dismiss
one match or all matches in a file. Counts include matches beyond the current page
and decrease as results are dismissed. Removing the final match removes the file
group. Dismissal never changes files, and running a new search restores results.

In Search, Files to include, and Files to exclude, press Up/Down to recall
previous values. Each field keeps its 20 most recent distinct values per
workspace, including searches run while typing, and retains them across VS Code
restarts. Down past the newest value clears the field.

Use Up/Down and Home/End to navigate visible rows, Left/Right to collapse, expand,
or move between a file and its matches, and Enter to open a match. Delete or
Cmd+Backspace dismisses the focused row. Tab reaches its dismiss action. File icons
follow `workbench.iconTheme`, including image and font themes, and update when the
theme changes. Selecting no icon theme hides icons; pnpm and TypeScript logos
appear when the selected theme supplies them. `search.showLineNumbers` controls
line labels. Large result sets load in batches of 300 visible file/match rows.

Settings:

- `fastSearch.filePicker.maxResults` — `100` by default.
- `fastSearch.filePicker.preserveInput` — inherits `search.quickAccess.preserveInput` when unset.
- `fastSearch.logging.level` — `error`, `warn`, `info`, or `debug`; default `warn`.

The first scan is cold and proportional to the workspace tree. Roots become searchable as they finish, and watcher events captured during the scan are replayed before readiness. Warm filename queries operate on an in-memory snapshot; text search still reads candidate contents in parallel and streams bounded batches. The release targets are native filename-search p95 ≤25 ms, command-to-visible p95 ≤50 ms, first partial results ≤250 ms, cancellation acknowledgement ≤50 ms, and ≤300 MiB RSS for one million average paths. On the development arm64 Mac, the checked benchmark currently measures about 9 ms filename p95, 179 MiB peak RSS, an 8 ms first content batch, and about 1 ms cancellation acknowledgement. End-to-end UI timing remains a release-machine measurement, not a universal filesystem claim.

Hosted CI runs benchmarks in a separate job from builds and VS Code tests and enforces a 40 ms filename-search p95 budget to allow for slower shared runners. Local benchmarks retain the 25 ms release target. Both warm the real search workload for at least two seconds and five searches before collecting 200 samples. The nearest-rank p95 includes every measured search, without filtering slow samples or retrying a failed measurement. Warm-up counts, Rayon thread counts, and the timing range are logged to help diagnose runner variability. Run local benchmarks without concurrent builds or other benchmarks. Set a positive integer `FAST_SEARCH_FILENAME_P95_MS` to override the filename budget, for example `FAST_SEARCH_FILENAME_P95_MS=40 pnpm run benchmark`. Invalid values fail the benchmark; memory, content-search, and cancellation limits remain unchanged.

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

### Search selected folders

Enter `src` in **Files to include** to search files beneath folders named
`src` at any depth. Enter `src, docs` to search both folders. Folder matches
are recursive and respect path boundaries: `src` does not select `src-old`.
A trailing slash, such as `src/`, selects folder contents only; without it,
a file named `src` can also match. Globs such as `**/*.swift` remain supported.

In a single-root workspace, `./src` selects only the top-level `src` folder.
In a multi-root workspace, `./backend` selects the root displayed as `backend`,
and `./backend/src` selects its top-level `src` folder. Use the workspace's
configured display name, which can differ from the folder name on disk.
Duplicate display names select every matching root; unknown names return no
results. Paths use forward slashes. Filters run before file contents are read;
existing ignore settings and exclusions still apply.

## Development

Prerequisites are macOS, Node.js 26+, pnpm, Rust 1.98+, Xcode command-line tools, `cargo-deny`, `cargo-about`, and `@vscode/vsce` from the lockfile.

The repository pins pnpm 12.4.1. Install the license tools with `cargo install cargo-deny --locked` and `cargo install cargo-about --locked --features cli` if they are not already available.

```sh
pnpm install --frozen-lockfile
pnpm run test:integration       # native black-box protocol flow first
pnpm run test:extension         # packaged-sidecar extension-host flow
pnpm run test:ui                # browser interactions, visuals, accessibility
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

### Automated UI tests

With Docker running, `pnpm run test:ui` renders the production search
webview HTML, CSS, and JavaScript in Chromium. It checks interactions,
keyboard navigation, tooltip visibility, flush sidebar edges, narrow
sidebar overflow, and automated WCAG accessibility rules. Screenshot
comparisons cover light, dark, and high-contrast themes at 320 px and
180 px sidebar widths, including results, hover help, empty, searching,
and error states.

Local runs and the dedicated CI `ui` job use the same official Playwright
Linux arm64 container. Its version follows the exact `@playwright/test`
dependency. A bundled test font and fixed theme tokens keep rendering
repeatable across machines. Only the VS Code message transport is stubbed;
the existing extension-host suite continues to check the real host.

For an intentional UI change, run `pnpm run test:ui:update`, inspect the
changed PNGs in `test/ui/snapshots`, and commit them with the change.
Then run `pnpm run test:ui` to verify the comparisons. CI never updates
baselines automatically. Failures produce `playwright-report` and
`test-results` with expected, actual, and diff images plus browser traces;
CI uploads those as the `ui-test-report` artifact for 14 days.

### Install and visually test a local build

Use stock VS Code 1.137.0 or newer on macOS arm64 or x86_64, with the [development prerequisites](#development) installed. Both Rust Apple targets are required because the VSIX includes a universal engine, even when you only test on one architecture.

From the repository root, run:

```sh
pnpm install --frozen-lockfile
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm run package
```

Packaging checks dependency licenses and the generated third-party notices, builds the Rust engine for both Apple targets, combines them with `lipo`, bundles the extension, and creates `vscode-fast-search-0.1.0.vsix` in the repository root. The filename follows the version in `package.json`. If packaging fails, resolve the reported license or build error before installing; an older VSIX does not contain your latest changes.

1. Open VS Code and press **Cmd+Shift+P** to open the Command Palette.
2. Run **Extensions: Install from VSIX…** and select the newly generated VSIX from the repository root. Reload VS Code if prompted.
3. Use **File > Open Folder…** to open `test/fixtures/workspace` from this repository as the workspace root. Trust that folder when prompted. Fast Search requires a trusted local folder; remote workspaces are unsupported.
4. Run the checks below through the Command Palette. Shortcut remapping is optional; see [Install and shortcuts](#install-and-shortcuts).

#### Visual smoke checks

- Run **Fast Search: Open File** and type `Result`. Expect `src/Result.swift` (the picker shows the filename with its directory). Move the active selection to preview the file, press Enter to pin it, and reopen the picker to try the **Open to the Side** button. Searching `Result:2` and accepting the result should navigate to line 2.
- Run **Fast Search: Find in Files** and search for `searchable fixture`. Expect a highlighted match on line 2 of `src/Result.swift`; selecting the result should open the matching location. Check the literal/regex, case, whole-word, and include/exclude controls. For example, including `**/*.swift` should retain this match, while excluding `**/*.swift` should remove it.
- Switch between light and dark themes and check that controls, text, and result highlights remain readable. Select Seti and another installed file-icon theme, then disable file icons; verify that result icons follow your selection. Collapse a file, dismiss a match, and dismiss its remaining results; verify counts and focus, then rerun the search to restore results. Use the keyboard to navigate the picker and Tab through the search controls, checking visible focus and result navigation.
- Run **Fast Search: Rebuild Index**, then repeat the searches. Run **Fast Search: Show Diagnostics** to inspect engine readiness and the indexed-file count. If startup fails or results stay stale, inspect the reported state and stderr there.
- Open a larger trusted local workspace to observe indexing progress and try searching during the initial scan; the tiny fixture may finish too quickly to show progress. Search its own filenames and contents, since the fixture examples only apply to the fixture folder.

After editing the extension or native engine, rerun `pnpm run package`, install the newly generated VSIX again using **Extensions: Install from VSIX…**, and run **Developer: Reload Window** to load the new code. Rebuilding alone does not update an installed extension.

`pnpm run test:extension` runs automated checks in a separate extension host. It does not install the VSIX into your regular VS Code window or replace these manual visual checks. Release-candidate checks for accessibility and crash recovery still apply.

## Privacy, licensing, and contributing

All indexing and search execute locally. There is no telemetry or network service. Paths and contents are never transmitted; only paths and compact index metadata live in memory, and file contents are not persisted.

Original code is MIT licensed. Unmodified `nucleo-matcher` is MPL-2.0; ripgrep search components and other dependencies retain their permissive licenses. See `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_NOTICES_JS.md`. If MPL-covered source is modified, the modified covered files must remain available under MPL-2.0.

Contributions should preserve dependency direction, add behavior at its owning boundary, keep protocol changes mirrored and versioned, and put each semantic behavior in one integration suite.
