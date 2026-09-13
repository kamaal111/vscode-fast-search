# Architecture and protocol

## Boundary

The extension starts one engine per extension host. The process client is the sole owner of spawning, stdin/stdout, request IDs, fragmented-line decoding, response routing, stale-ID suppression, one-shot crash restart, stderr logging, and shutdown. Feature code depends on the `EngineClient` interface. Rust code has no VS Code dependency.

Messages are protocol version 1, UTF-8, one JSON object per line. Stdout is reserved for messages and stderr for human-readable logs. Both sides reject malformed envelopes and payloads. Every message carries `version`, `type`, and `requestId`.

Requests are `initialize`, `reconfigure`, `fileSearch`, `textSearch`, `cancel`, `status`, and `shutdown`. Engine events are `indexProgress`, `indexReady`, `fileResults`, `textResultBatch`, `textSearchComplete`, `requestError`, and `diagnostics`. Initialization carries root IDs/paths and resolved settings. Filename search may carry active-editor URI/directory. Text search carries resolved options and dirty or untitled overlays. Protocol changes that are not backward compatible require a version increment.

## Ownership and concurrency

The main engine thread reads and validates requests. Initial and replacement scans run off that thread. Initial roots publish immutable partial snapshots as they finish; reconfiguration keeps the prior complete snapshot searchable until atomic replacement. A mutation lock serializes replacement scans with watcher refreshes, while snapshot readers need only a short read lock. Filename and text operations run on worker threads, with Rayon partitioning both candidate sets. Each request observes a generation token. A new same-kind request advances the token, while `cancel` advances it only when its target request is still active. Text matching emits through `TextResultSink`, keeping batching independent from stdout.

The index owns roots, scanning, resource-scoped exclusion globs, ignore interpretation, normalized `/`-separated relative paths, filename offsets, saturated lowercase character counts, and numeric candidate postings. An immutable snapshot never contains duplicate `(root ID, relative path)` identities; every path is relative to its declared root; generations increase on replacement; file contents are never stored. Unreadable and concurrently removed entries are skipped and reported for text search. Symlink traversal is off unless configured, and the walker detects cycles.

The engine starts a native polling watcher before the initial scan. Its channel buffers concurrent events; after scanning, the engine drains and applies those events before declaring readiness, then hands the same channel to the long-lived watcher loop. Event storms are coalesced for 40 ms and only affected root snapshots are rescanned and atomically replaced. This preserves searchable old snapshots and makes create, rename, directory, and delete changes visible without persisting contents.

## Search behavior

Filename queries normalize to path text, split on whitespace, reject impossible candidates with the independently implemented character bag, and use the unmodified `nucleo-matcher` crate for scoring and matched positions. Ranking adds independently designed filename-prefix, shorter-path, and active-directory bonuses. `path:line[:column]` is parsed below presentation.

Text options are resolved before candidates are opened. Include and explicit exclude globs run first; ignored files stay outside the persistent snapshot unless a query-specific exclusion-disabled walk is requested. The ripgrep matcher/searcher crates implement literal, regex, case, smart-case, whole-word, and multiline matching. Binary files are rejected by NUL detection; UTF-8 BOM, configured WHATWG encoding labels, and lossy UTF-8 fallback are supported. Dirty overlays replace disk bytes and untitled overlays join the candidate set. Returned start/end ranges and preview highlights use VS Code-compatible UTF-16 columns, including multiline matches. Batches flush at 128 matches or approximately 16 ms, and workers stop at targeted cancellation or the global result limit.

## Performance reasoning

Keeping normalized paths and compact rejection metadata in immutable memory removes filesystem work from warm filename matching. Saturated character counts reject impossible candidates, digit postings narrow numeric queries, Rayon spreads survivors, and result strings/positions are allocated only for the final bounded set. Text search cannot avoid content I/O, so pre-open globs, parallel reads, binary rejection, early limits, streaming, and cancellation matter more than retaining contents.

Benchmarks must generate their own one-million-path and content corpora outside the repository. Record native and VS Code end-to-end p50/p95, peak RSS, first-batch time, and cancellation acknowledgement on the same Apple Silicon machine. Zed and stock VS Code may be timed on the same representative repository only as behavioral comparisons; their source or fixtures are never imported.

## Independent implementation

Observed Zed behavior—fast fuzzy file navigation, responsive streamed search, and a persistent project index—motivates the user experience. Fast Search's protocol, data layout, ranking bonuses, cancellation generations, modules, tests, and UI are original. No GPL-covered Zed implementation was copied or mechanically translated. Reusing Zed implementation details or modifying MPL-covered dependency files requires a fresh license review.
