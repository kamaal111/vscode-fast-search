#[cfg(test)]
#[path = "../benches/support/filename_budget_tests.rs"]
mod filename_budget_tests;

use encoding_rs::Encoding;
use fast_search_index::{
    IndexedPath, Snapshot, bag_contains_requirements, bag_requirements, character_bag,
};
use fast_search_protocol::{
    ActiveEditor, DocumentOverlay, FileMatch, TextMatch, TextSearchOptions,
};
use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_matcher::Matcher as GrepMatcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{SearcherBuilder, sinks::UTF8};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use rayon::prelude::*;
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFileQuery {
    pub query: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

pub fn parse_file_query(input: &str) -> ParsedFileQuery {
    let mut parts = input.rsplitn(3, ':');
    let last = parts.next().unwrap_or_default();
    let second = parts.next();
    let third = parts.next();
    match (third, second, last.parse::<u32>().ok()) {
        (Some(path), Some(line), Some(column)) if line.parse::<u32>().is_ok() => ParsedFileQuery {
            query: path.to_owned(),
            line: line.parse().ok(),
            column: Some(column),
        },
        (_, Some(path), Some(line)) => ParsedFileQuery {
            query: path.to_owned(),
            line: Some(line),
            column: None,
        },
        _ => ParsedFileQuery {
            query: input.to_owned(),
            line: None,
            column: None,
        },
    }
}

#[derive(Clone, Default)]
pub struct Cancellation {
    generations: Arc<AtomicU64>,
}
impl Cancellation {
    pub fn token(&self) -> u64 {
        self.generations.load(Ordering::Acquire)
    }
    pub fn cancel(&self) {
        self.generations.fetch_add(1, Ordering::AcqRel);
    }
    pub fn is_cancelled(&self, token: u64) -> bool {
        token != self.token()
    }
}

#[derive(Clone, Default)]
pub struct FileSearcher {
    cancellation: Cancellation,
}

#[derive(Debug)]
struct ScoredPath {
    index: usize,
    score: i64,
}

impl FileSearcher {
    pub fn cancellation(&self) -> Cancellation {
        self.cancellation.clone()
    }
    pub fn search(
        &self,
        snapshot: &Snapshot,
        raw_query: &str,
        max_results: usize,
        active: Option<&ActiveEditor>,
        token: u64,
    ) -> Vec<FileMatch> {
        let parsed = parse_file_query(raw_query);
        let atoms: Vec<String> = parsed
            .query
            .split_whitespace()
            .map(str::to_lowercase)
            .collect();
        let needed_bag = character_bag(&atoms.join(""));
        let requirements = bag_requirements(needed_bag);
        if max_results == 0 {
            return Vec::new();
        }
        let mut scored = if let Some(indices) = snapshot.digit_candidates(&parsed.query) {
            score_candidates(
                indices.par_iter().map(|index| *index as usize),
                snapshot,
                &atoms,
                &requirements,
                active,
                &self.cancellation,
                token,
                max_results,
            )
        } else {
            score_candidates(
                (0..snapshot.files.len()).into_par_iter(),
                snapshot,
                &atoms,
                &requirements,
                active,
                &self.cancellation,
                token,
                max_results,
            )
        };
        truncate_scores(&mut scored, snapshot, max_results);
        scored
            .into_iter()
            .map(|scored| {
                let path = &snapshot.files[scored.index];
                FileMatch {
                    uri: path.uri(),
                    relative_path: path.relative_path.to_string(),
                    root_id: path.root_id.to_string(),
                    score: scored.score,
                    positions: matched_positions(&path.relative_path, &atoms),
                    line: parsed.line,
                    column: parsed.column,
                }
            })
            .collect()
    }
}

#[allow(clippy::too_many_arguments)]
fn score_candidates<I>(
    indices: I,
    snapshot: &Snapshot,
    atoms: &[String],
    requirements: &[(u8, u8)],
    active: Option<&ActiveEditor>,
    cancellation: &Cancellation,
    token: u64,
    max_results: usize,
) -> Vec<ScoredPath>
where
    I: ParallelIterator<Item = usize>,
{
    indices
        .map_init(
            || Matcher::new(filename_matcher_config()),
            |matcher, index| {
                let path = &snapshot.files[index];
                if cancellation.is_cancelled(token)
                    || !bag_contains_requirements(path.character_bag, requirements)
                    || !atoms
                        .iter()
                        .all(|atom| ascii_subsequence(path.relative_path.as_ref(), atom))
                {
                    return None;
                }
                score_path(matcher, path, atoms, active).map(|score| ScoredPath { index, score })
            },
        )
        .filter_map(std::convert::identity)
        .fold(Vec::new, |mut top, scored| {
            top.push(scored);
            if top.len() >= max_results.saturating_mul(2) {
                truncate_scores(&mut top, snapshot, max_results);
            }
            top
        })
        .reduce(Vec::new, |mut left, mut right| {
            left.append(&mut right);
            truncate_scores(&mut left, snapshot, max_results);
            left
        })
}

fn truncate_scores(scored: &mut Vec<ScoredPath>, snapshot: &Snapshot, max_results: usize) {
    scored.sort_unstable_by(|a, b| {
        b.score.cmp(&a.score).then_with(|| {
            snapshot.files[a.index]
                .relative_path
                .cmp(&snapshot.files[b.index].relative_path)
        })
    });
    scored.truncate(max_results);
}

fn filename_matcher_config() -> Config {
    let mut config = Config::DEFAULT.match_paths();
    config.normalize = false;
    config
}

fn ascii_subsequence(candidate: &str, atom: &str) -> bool {
    if !atom.is_ascii() {
        return true;
    }
    let mut needed = atom.bytes();
    let mut current = needed.next();
    for byte in candidate.bytes() {
        if current.is_some_and(|value| byte.to_ascii_lowercase() == value) {
            current = needed.next();
            if current.is_none() {
                return true;
            }
        }
    }
    current.is_none()
}

fn score_path(
    matcher: &mut Matcher,
    path: &IndexedPath,
    atoms: &[String],
    active: Option<&ActiveEditor>,
) -> Option<i64> {
    if atoms.is_empty() {
        return Some(-(path.relative_path.len() as i64));
    }
    let mut total = 0_i64;
    let mut haystack_buf = Vec::new();
    let haystack = Utf32Str::new(path.relative_path.as_ref(), &mut haystack_buf);
    for atom in atoms {
        let mut needle_buf = Vec::new();
        let needle = Utf32Str::new(atom, &mut needle_buf);
        let score = matcher.fuzzy_match_greedy(haystack, needle)?;
        total += i64::from(score);
    }
    let filename = &path.relative_path[path.filename_offset..];
    if atoms.iter().any(|atom| ascii_starts_with(filename, atom)) {
        total += 120;
    }
    total -= (path.relative_path.matches('/').count() * 3) as i64;
    if active.is_some_and(|editor| {
        path.absolute_path()
            .parent()
            .is_some_and(|parent| parent.to_string_lossy() == editor.directory)
    }) {
        total += 80;
    }
    if active.is_some_and(|editor| {
        let active_path = editor.uri.strip_prefix("file://").unwrap_or(&editor.uri);
        Path::new(active_path).extension() == path.absolute_path().extension()
    }) {
        total += 20;
    }
    Some(total)
}

fn ascii_starts_with(candidate: &str, prefix: &str) -> bool {
    candidate.len() >= prefix.len()
        && candidate.as_bytes()[..prefix.len()]
            .iter()
            .zip(prefix.bytes())
            .all(|(candidate, prefix)| candidate.to_ascii_lowercase() == prefix)
}

fn matched_positions(path: &str, atoms: &[String]) -> Vec<u32> {
    let mut matcher = Matcher::new(filename_matcher_config());
    let mut all_positions = Vec::new();
    for atom in atoms {
        let mut haystack_buf = Vec::new();
        let mut needle_buf = Vec::new();
        let haystack = Utf32Str::new(path, &mut haystack_buf);
        let needle = Utf32Str::new(atom, &mut needle_buf);
        let _ = matcher.fuzzy_indices(haystack, needle, &mut all_positions);
    }
    all_positions.sort_unstable();
    all_positions.dedup();
    all_positions
}

pub trait TextResultSink: Send + Sync {
    fn emit(&self, results: Vec<TextMatch>);
}

#[derive(Debug, Clone, Default)]
pub struct TextSearchSummary {
    pub result_count: usize,
    pub limit_hit: bool,
    pub cancelled: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Default)]
pub struct TextSearcher {
    cancellation: Cancellation,
}
impl TextSearcher {
    pub fn cancellation(&self) -> Cancellation {
        self.cancellation.clone()
    }
    pub fn search(
        &self,
        snapshot: &Snapshot,
        query: &str,
        options: &TextSearchOptions,
        overlays: &[DocumentOverlay],
        sink: &dyn TextResultSink,
        token: u64,
    ) -> Result<TextSearchSummary, String> {
        let regex = build_regex(query, options)?;
        let includes = build_globs(&options.includes)?;
        let excludes = build_globs(&options.excludes)?;
        let overlay_map: HashMap<&str, &DocumentOverlay> = overlays
            .iter()
            .map(|overlay| (overlay.uri.as_str(), overlay))
            .collect();
        let result_count = AtomicUsize::new(0);
        let pending = Mutex::new((Vec::<TextMatch>::new(), Instant::now()));
        let warnings = Mutex::new(Vec::new());
        let submit = |mut found: Vec<TextMatch>| {
            if found.is_empty() {
                return;
            }
            let accepted = loop {
                let current = result_count.load(Ordering::Acquire);
                if current >= options.max_results {
                    return;
                }
                let accepted = found.len().min(options.max_results - current);
                if result_count
                    .compare_exchange(
                        current,
                        current + accepted,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    )
                    .is_ok()
                {
                    break accepted;
                }
            };
            found.truncate(accepted);
            let emit = {
                let mut state = pending.lock().unwrap_or_else(|error| error.into_inner());
                state.0.extend(found);
                if state.0.len() >= 128
                    || state.1.elapsed() >= Duration::from_millis(16)
                    || result_count.load(Ordering::Acquire) >= options.max_results
                {
                    state.1 = Instant::now();
                    Some(std::mem::take(&mut state.0))
                } else {
                    None
                }
            };
            if let Some(results) = emit {
                sink.emit(results);
            }
        };
        snapshot.files.par_iter().for_each(|file| {
            if self.cancellation.is_cancelled(token)
                || result_count.load(Ordering::Acquire) >= options.max_results
            {
                return;
            }
            let relative = file.relative_path.as_ref();
            if includes.as_ref().is_some_and(|set| !set.is_match(relative))
                || excludes.as_ref().is_some_and(|set| set.is_match(relative))
            {
                return;
            }
            let uri = file.uri();
            let bytes = if let Some(overlay) = overlay_map.get(uri.as_str()) {
                overlay.text.as_bytes().to_vec()
            } else {
                match fs::read(file.absolute_path()) {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        warnings
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .push(format!("{}: {error}", file.relative_path));
                        return;
                    }
                }
            };
            if bytes.iter().take(8_192).any(|byte| *byte == 0) {
                return;
            }
            let text = decode_text(&bytes, options.encoding.as_deref());
            let remaining = options
                .max_results
                .saturating_sub(result_count.load(Ordering::Acquire));
            let mut found = Vec::new();
            collect_matches(
                &regex,
                &text,
                &uri,
                file.root_id.as_ref(),
                &mut found,
                remaining,
            );
            submit(found);
        });
        if !self.cancellation.is_cancelled(token)
            && result_count.load(Ordering::Acquire) < options.max_results
        {
            for overlay in overlays.iter().filter(|overlay| {
                overlay.untitled && !snapshot.files.iter().any(|file| file.uri() == overlay.uri)
            }) {
                if self.cancellation.is_cancelled(token)
                    || result_count.load(Ordering::Acquire) >= options.max_results
                {
                    break;
                }
                if includes
                    .as_ref()
                    .is_some_and(|set| !set.is_match(&overlay.uri))
                    || excludes
                        .as_ref()
                        .is_some_and(|set| set.is_match(&overlay.uri))
                {
                    continue;
                }
                let remaining = options
                    .max_results
                    .saturating_sub(result_count.load(Ordering::Acquire));
                let mut found = Vec::new();
                collect_matches(
                    &regex,
                    &overlay.text,
                    &overlay.uri,
                    "untitled",
                    &mut found,
                    remaining,
                );
                submit(found);
            }
        }
        let remaining_batch = {
            let mut state = pending.lock().unwrap_or_else(|error| error.into_inner());
            std::mem::take(&mut state.0)
        };
        if !remaining_batch.is_empty() {
            sink.emit(remaining_batch);
        }
        let result_count = result_count.load(Ordering::Acquire);
        let mut warnings = warnings
            .into_inner()
            .unwrap_or_else(|error| error.into_inner());
        warnings.sort();
        Ok(TextSearchSummary {
            result_count,
            limit_hit: result_count >= options.max_results,
            cancelled: self.cancellation.is_cancelled(token),
            warnings,
        })
    }
}

fn build_regex(query: &str, options: &TextSearchOptions) -> Result<RegexMatcher, String> {
    let case_sensitive =
        options.case_sensitive || (options.smart_case && query.chars().any(char::is_uppercase));
    RegexMatcherBuilder::new()
        .fixed_strings(!options.regex)
        .word(options.whole_word)
        .case_insensitive(!case_sensitive)
        .multi_line(options.multiline)
        .dot_matches_new_line(options.multiline)
        .build(query)
        .map_err(|error| error.to_string())
}

fn build_globs(patterns: &[String]) -> Result<Option<GlobSet>, String> {
    if patterns.is_empty() {
        return Ok(None);
    }
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder.add(Glob::new(pattern).map_err(|error| error.to_string())?);
    }
    builder.build().map(Some).map_err(|error| error.to_string())
}

fn decode_text(bytes: &[u8], configured_encoding: Option<&str>) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if let Some(encoding) =
        configured_encoding.and_then(|label| Encoding::for_label(label.as_bytes()))
    {
        let (text, _, _) = encoding.decode(bytes);
        return text.into_owned();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn collect_matches(
    regex: &RegexMatcher,
    text: &str,
    uri: &str,
    root_id: &str,
    output: &mut Vec<TextMatch>,
    limit: usize,
) -> usize {
    let initial_len = output.len();
    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .multi_line(true)
        .build();
    if let Err(error) = searcher.search_slice(
        regex,
        text.as_bytes(),
        UTF8(|base_line, matched_lines| {
            let _ = regex.find_iter(matched_lines.as_bytes(), |found| {
                if output.len() - initial_len >= limit {
                    return false;
                }
                let start = found.start();
                let end = found.end();
                let line_start = matched_lines[..start]
                    .rfind('\n')
                    .map_or(0, |value| value + 1);
                let line_end = matched_lines[end..]
                    .find('\n')
                    .map_or(matched_lines.len(), |value| end + value);
                let relative_line = matched_lines[..start]
                    .bytes()
                    .filter(|byte| *byte == b'\n')
                    .count() as u32;
                let end_line_start = matched_lines[..end]
                    .rfind('\n')
                    .map_or(0, |value| value + 1);
                let relative_end_line = matched_lines[..end]
                    .bytes()
                    .filter(|byte| *byte == b'\n')
                    .count() as u32;
                output.push(TextMatch {
                    uri: uri.to_owned(),
                    root_id: root_id.to_owned(),
                    line: base_line.saturating_sub(1) as u32 + relative_line,
                    start_column: utf16_len(&matched_lines[line_start..start]),
                    end_line: base_line.saturating_sub(1) as u32 + relative_end_line,
                    end_column: utf16_len(&matched_lines[end_line_start..end]),
                    preview: matched_lines[line_start..line_end]
                        .trim_end_matches('\r')
                        .to_owned(),
                    preview_start: utf16_len(&matched_lines[line_start..start]),
                    preview_end: utf16_len(&matched_lines[line_start..end]),
                });
                true
            });
            Ok::<bool, std::io::Error>(output.len() - initial_len < limit)
        }),
    ) {
        eprintln!("text searcher failed: {error}");
    }
    output.len() - initial_len
}

fn utf16_len(value: &str) -> u32 {
    value.encode_utf16().count() as u32
}

#[cfg(test)]
mod tests {
    use super::{FileSearcher, ParsedFileQuery, parse_file_query};
    use fast_search_index::{IndexedPath, Snapshot, character_bag};
    use std::{path::PathBuf, sync::Arc};
    #[test]
    fn parses_line_and_column() {
        assert_eq!(
            parse_file_query("src/main.rs:12:4"),
            ParsedFileQuery {
                query: "src/main.rs".into(),
                line: Some(12),
                column: Some(4)
            }
        );
    }
    #[test]
    fn keeps_colons_without_positions() {
        assert_eq!(
            parse_file_query("src:name"),
            ParsedFileQuery {
                query: "src:name".into(),
                line: None,
                column: None
            }
        );
    }

    #[test]
    fn filename_prefix_breaks_a_full_path_fuzzy_tie() {
        let root_id: Arc<str> = Arc::from("root");
        let root_path = Arc::new(PathBuf::from("/workspace"));
        let make = |relative: &'static str| IndexedPath {
            root_id: Arc::clone(&root_id),
            root_path: Arc::clone(&root_path),
            filename_offset: relative.rfind('/').map_or(0, |value| value + 1),
            character_bag: character_bag(relative),
            relative_path: Arc::from(relative),
        };
        let snapshot = Snapshot::new(vec![make("folder/Foo.rs"), make("Foo/folder.rs")], 1);
        let searcher = FileSearcher::default();
        let results = searcher.search(&snapshot, "foo", 2, None, searcher.cancellation().token());
        assert_eq!(results[0].relative_path, "folder/Foo.rs");
    }
}
