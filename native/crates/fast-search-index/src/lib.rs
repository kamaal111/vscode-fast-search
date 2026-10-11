use fast_search_protocol::ExclusionRule;
use globset::{GlobBuilder, GlobMatcher, GlobSet, GlobSetBuilder};
use ignore::{WalkBuilder, WalkState};
use percent_encoding::{AsciiSet, CONTROLS, percent_decode_str, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RootSpec {
    pub id: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct IndexOptions {
    pub excludes: Vec<String>,
    pub root_excludes: HashMap<String, Vec<ExclusionRule>>,
    pub use_ignore_files: bool,
    pub use_ignore_files_by_root: HashMap<String, bool>,
    pub use_global_ignore_files: bool,
    pub use_global_ignore_files_by_root: HashMap<String, bool>,
    pub use_parent_ignore_files: bool,
    pub use_parent_ignore_files_by_root: HashMap<String, bool>,
    pub follow_symlinks: bool,
    pub follow_symlinks_by_root: HashMap<String, bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedPath {
    pub root_id: Arc<str>,
    pub root_path: Arc<PathBuf>,
    pub relative_path: Arc<str>,
    pub filename_offset: usize,
    pub character_bag: u64,
}

impl IndexedPath {
    pub fn absolute_path(&self) -> PathBuf {
        self.root_path.join(self.relative_path.as_ref())
    }
    pub fn uri(&self) -> String {
        format!(
            "file://{}",
            utf8_percent_encode(&self.absolute_path().to_string_lossy(), FILE_URI_ENCODE_SET)
        )
    }
}

const FILE_URI_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}');

#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    pub files: Arc<Vec<IndexedPath>>,
    digit_postings: Arc<Vec<Vec<u32>>>,
    pub generation: u64,
}

impl Snapshot {
    pub fn new(files: Vec<IndexedPath>, generation: u64) -> Self {
        const DIGIT_COUNT_LEVELS: usize = 8;
        let mut postings = vec![Vec::new(); 10 * DIGIT_COUNT_LEVELS];
        for (index, file) in files.iter().enumerate() {
            let mut counts = [0_u8; 10];
            for byte in file
                .relative_path
                .bytes()
                .filter(|byte| byte.is_ascii_digit())
            {
                let digit = usize::from(byte - b'0');
                counts[digit] = counts[digit]
                    .saturating_add(1)
                    .min(DIGIT_COUNT_LEVELS as u8);
            }
            for (digit, count) in counts.into_iter().enumerate() {
                for threshold in 1..=count {
                    postings[digit * DIGIT_COUNT_LEVELS + usize::from(threshold - 1)]
                        .push(index as u32);
                }
            }
        }
        Self {
            files: Arc::new(files),
            digit_postings: Arc::new(postings),
            generation,
        }
    }

    pub fn digit_candidates(&self, query: &str) -> Option<&[u32]> {
        const DIGIT_COUNT_LEVELS: usize = 8;
        let mut counts = [0_u8; 10];
        for byte in query.bytes().filter(|byte| byte.is_ascii_digit()) {
            let digit = usize::from(byte - b'0');
            counts[digit] = counts[digit]
                .saturating_add(1)
                .min(DIGIT_COUNT_LEVELS as u8);
        }
        counts
            .into_iter()
            .enumerate()
            .filter(|(_, count)| *count > 0)
            .map(|(digit, count)| {
                self.digit_postings[digit * DIGIT_COUNT_LEVELS + usize::from(count - 1)].as_slice()
            })
            .min_by_key(|posting| posting.len())
    }
}

#[derive(Debug, Clone, Default)]
pub struct Diagnostics {
    pub ready: bool,
    pub file_count: usize,
    pub roots: usize,
    pub generation: u64,
    pub last_error: Option<String>,
}

#[derive(Default)]
struct State {
    roots: Vec<RootSpec>,
    options: IndexOptions,
    snapshot: Snapshot,
    ready: bool,
    last_error: Option<String>,
}

#[derive(Clone, Default)]
pub struct WorkspaceIndex {
    state: Arc<RwLock<State>>,
    mutation: Arc<Mutex<()>>,
}

impl WorkspaceIndex {
    pub fn configure(
        &self,
        roots: Vec<RootSpec>,
        options: IndexOptions,
    ) -> Result<Snapshot, String> {
        self.configure_with_progress(roots, options, |_, _| {})
    }

    pub fn configure_with_progress(
        &self,
        roots: Vec<RootSpec>,
        options: IndexOptions,
        mut progress: impl FnMut(&RootSpec, usize),
    ) -> Result<Snapshot, String> {
        let _mutation = self
            .mutation
            .lock()
            .map_err(|_| "index mutation lock poisoned")?;
        let (mut generation, expose_partial) = {
            let mut state = self.state.write().map_err(|_| "index lock poisoned")?;
            let expose_partial = state.snapshot.files.is_empty();
            let generation = state.snapshot.generation;
            state.roots = roots.clone();
            state.options = options.clone();
            state.ready = false;
            state.last_error = None;
            (generation, expose_partial)
        };
        let mut files = Vec::new();
        for root in &roots {
            let root_files = scan(std::slice::from_ref(root), &options);
            progress(root, root_files.len());
            files.extend(root_files);
            if expose_partial {
                generation += 1;
                self.state
                    .write()
                    .map_err(|_| "index lock poisoned")?
                    .snapshot = Snapshot::new(files.clone(), generation);
            }
        }
        files.sort_by(|a, b| {
            a.root_id
                .cmp(&b.root_id)
                .then_with(|| a.relative_path.cmp(&b.relative_path))
        });
        generation += 1;
        let snapshot = Snapshot::new(files, generation);
        let mut state = self.state.write().map_err(|_| "index lock poisoned")?;
        state.snapshot = snapshot.clone();
        state.ready = true;
        Ok(snapshot)
    }

    pub fn rebuild(&self) -> Result<Snapshot, String> {
        let (roots, options) = {
            let s = self.state.read().map_err(|_| "index lock poisoned")?;
            (s.roots.clone(), s.options.clone())
        };
        self.configure(roots, options)
    }

    pub fn searchable_snapshot(&self) -> Snapshot {
        self.state
            .read()
            .map(|s| s.snapshot.clone())
            .unwrap_or_default()
    }

    pub fn apply_filesystem_changes(&self, changed_paths: &[PathBuf]) -> Result<Snapshot, String> {
        let _mutation = self
            .mutation
            .lock()
            .map_err(|_| "index mutation lock poisoned")?;
        let (affected, options, old_snapshot) = {
            let state = self.state.read().map_err(|_| "index lock poisoned")?;
            let affected: Vec<_> = state
                .roots
                .iter()
                .filter(|root| {
                    changed_paths
                        .iter()
                        .any(|path| path.starts_with(&root.path))
                })
                .cloned()
                .collect();
            (affected, state.options.clone(), state.snapshot.clone())
        };
        if affected.is_empty() {
            return Ok(old_snapshot);
        }
        let affected_ids: std::collections::HashSet<_> =
            affected.iter().map(|root| root.id.as_str()).collect();
        let mut files: Vec<_> = old_snapshot
            .files
            .iter()
            .filter(|file| !affected_ids.contains(file.root_id.as_ref()))
            .cloned()
            .collect();
        files.extend(scan(&affected, &options));
        files.sort_by(|a, b| {
            a.root_id
                .cmp(&b.root_id)
                .then_with(|| a.relative_path.cmp(&b.relative_path))
        });
        let snapshot = Snapshot::new(files, old_snapshot.generation + 1);
        self.state
            .write()
            .map_err(|_| "index lock poisoned")?
            .snapshot = snapshot.clone();
        Ok(snapshot)
    }

    pub fn diagnostics(&self) -> Diagnostics {
        self.state
            .read()
            .map(|s| Diagnostics {
                ready: s.ready,
                file_count: s.snapshot.files.len(),
                roots: s.roots.len(),
                generation: s.snapshot.generation,
                last_error: s.last_error.clone(),
            })
            .unwrap_or_default()
    }
}

fn scan(roots: &[RootSpec], options: &IndexOptions) -> Vec<IndexedPath> {
    let mut unique = HashMap::<(String, String), IndexedPath>::new();
    let global_excludes = build_excludes(&options.excludes);
    for root in roots {
        let use_ignore_files = options
            .use_ignore_files_by_root
            .get(&root.id)
            .copied()
            .unwrap_or(options.use_ignore_files);
        let follow_symlinks = options
            .follow_symlinks_by_root
            .get(&root.id)
            .copied()
            .unwrap_or(options.follow_symlinks);
        let root_excludes = ExclusionMatcher::new(
            options
                .root_excludes
                .get(&root.id)
                .map(Vec::as_slice)
                .unwrap_or_default(),
        );
        let mut builder = WalkBuilder::new(&root.path);
        builder
            .hidden(false)
            .follow_links(follow_symlinks)
            .ignore(use_ignore_files)
            .git_ignore(use_ignore_files)
            .git_global(
                use_ignore_files
                    && options
                        .use_global_ignore_files_by_root
                        .get(&root.id)
                        .copied()
                        .unwrap_or(options.use_global_ignore_files),
            )
            .git_exclude(use_ignore_files)
            .parents(
                use_ignore_files
                    && options
                        .use_parent_ignore_files_by_root
                        .get(&root.id)
                        .copied()
                        .unwrap_or(options.use_parent_ignore_files),
            )
            .require_git(false);
        let discovered = Arc::new(Mutex::new(Vec::new()));
        builder.build_parallel().run(|| {
            let discovered = Arc::clone(&discovered);
            Box::new(move |item| {
                if let Ok(item) = item
                    && item.file_type().is_some_and(|kind| kind.is_file())
                {
                    discovered
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .push(item.into_path());
                }
                WalkState::Continue
            })
        });
        let discovered = discovered.lock().unwrap_or_else(|error| error.into_inner());
        for path in discovered.iter() {
            let Ok(relative) = path.strip_prefix(&root.path) else {
                continue;
            };
            let relative = relative.to_string_lossy().replace('\\', "/");
            if global_excludes.is_match(&relative)
                || root_excludes.is_match(&root.path, relative.as_str())
            {
                continue;
            }
            let filename_offset = relative.rfind('/').map_or(0, |offset| offset + 1);
            let indexed = IndexedPath {
                root_id: Arc::from(root.id.as_str()),
                root_path: Arc::new(root.path.clone()),
                relative_path: Arc::from(relative.as_str()),
                filename_offset,
                character_bag: character_bag(&relative),
            };
            unique.insert((root.id.clone(), relative), indexed);
        }
    }
    let mut files: Vec<_> = unique.into_values().collect();
    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    files
}

fn build_excludes(patterns: &[String]) -> GlobSet {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let normalized = pattern.trim().trim_matches('/');
        if let Ok(glob) = GlobBuilder::new(normalized).literal_separator(true).build() {
            builder.add(glob);
        }
        if !normalized.ends_with("/**")
            && let Ok(glob) = GlobBuilder::new(&format!("{normalized}/**"))
                .literal_separator(true)
                .build()
        {
            builder.add(glob);
        }
    }
    builder.build().unwrap_or_else(|_| GlobSet::empty())
}

struct ExclusionMatcher {
    unconditional: GlobSet,
    conditional: Vec<(GlobMatcher, String)>,
}

impl ExclusionMatcher {
    fn new(rules: &[ExclusionRule]) -> Self {
        let mut patterns = Vec::new();
        let mut conditional = Vec::new();
        for rule in rules {
            match rule {
                ExclusionRule::Pattern(pattern) => patterns.push(pattern.clone()),
                ExclusionRule::Conditional { pattern, when } => {
                    if let Ok(glob) = GlobBuilder::new(pattern.trim().trim_matches('/'))
                        .literal_separator(true)
                        .build()
                    {
                        conditional.push((glob.compile_matcher(), when.clone()));
                    }
                }
            }
        }
        Self {
            unconditional: build_excludes(&patterns),
            conditional,
        }
    }

    fn is_match(&self, root: &Path, relative: &str) -> bool {
        if self.unconditional.is_match(relative) {
            return true;
        }
        if self.conditional.is_empty() {
            return false;
        }
        let mut candidate = Some(Path::new(relative));
        while let Some(path) = candidate.filter(|path| !path.as_os_str().is_empty()) {
            for (pattern, when) in &self.conditional {
                if pattern.is_match(path) {
                    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
                    let sibling = when.replacen("$(basename)", &stem, 1);
                    if Path::new(&sibling)
                        .file_name()
                        .is_some_and(|name| name == sibling.as_str())
                        && root
                            .join(path.parent().unwrap_or_else(|| Path::new("")))
                            .join(sibling)
                            .exists()
                    {
                        return true;
                    }
                }
            }
            candidate = path.parent();
        }
        false
    }
}

pub fn character_bag(value: &str) -> u64 {
    value.bytes().fold(0_u64, |bag, byte| {
        let shift = ((byte.to_ascii_lowercase() as usize) & 31) * 2;
        let count = ((bag >> shift) & 0x3).saturating_add(1).min(0x3);
        (bag & !(0x3_u64 << shift)) | (count << shift)
    })
}

pub fn bag_contains(candidate: u64, query: u64) -> bool {
    bag_requirements(query)
        .iter()
        .all(|&(shift, count)| ((candidate >> shift) & 0x3) >= u64::from(count))
}

pub fn bag_requirements(query: u64) -> Vec<(u8, u8)> {
    (0_u8..32)
        .filter_map(|bucket| {
            let shift = bucket * 2;
            let count = ((query >> shift) & 0x3) as u8;
            (count > 0).then_some((shift, count))
        })
        .collect()
}

pub fn bag_contains_requirements(candidate: u64, requirements: &[(u8, u8)]) -> bool {
    requirements
        .iter()
        .all(|&(shift, count)| ((candidate >> shift) & 0x3) >= u64::from(count))
}

pub fn root_for_uri<'a>(roots: &'a [RootSpec], uri: &str) -> Option<(&'a str, &'a Path)> {
    let path = uri.strip_prefix("file://").unwrap_or(uri);
    let decoded = percent_decode_str(path).decode_utf8_lossy();
    roots
        .iter()
        .find(|root| Path::new(decoded.as_ref()).starts_with(&root.path))
        .map(|root| (root.id.as_str(), root.path.as_path()))
}

#[cfg(test)]
mod tests {
    use super::{bag_contains, character_bag};
    #[test]
    fn bag_is_case_insensitive() {
        assert_eq!(character_bag("Swift"), character_bag("sWIFT"));
    }

    #[test]
    fn bag_rejects_missing_repeated_characters() {
        assert!(!bag_contains(character_bag("file9"), character_bag("9999")));
    }
}
