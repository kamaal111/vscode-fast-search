use fast_search_core::FileSearcher;
use fast_search_index::{IndexedPath, Snapshot, character_bag};
use std::{hint::black_box, path::PathBuf, sync::Arc, time::Instant};

#[path = "support/filename_budget.rs"]
mod filename_budget;

fn main() {
    let configured_budget = match std::env::var("FAST_SEARCH_FILENAME_P95_MS") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(error) => panic!("invalid FAST_SEARCH_FILENAME_P95_MS: {error}"),
    };
    let budget = filename_budget::filename_budget(configured_budget.as_deref())
        .expect("invalid filename-search benchmark budget");
    let root_id: Arc<str> = Arc::from("benchmark");
    let root_path = Arc::new(PathBuf::from("/tmp/fast-search-benchmark"));
    let files: Vec<_> = (0..1_000_000)
        .map(|index| {
            let relative = format!("Sources/Module{index:07}/SearchService{index:07}.swift");
            IndexedPath {
                root_id: Arc::clone(&root_id),
                root_path: Arc::clone(&root_path),
                filename_offset: relative.rfind('/').map_or(0, |offset| offset + 1),
                character_bag: character_bag(&relative),
                relative_path: Arc::from(relative),
            }
        })
        .collect();
    let snapshot = Snapshot::new(files, 1);
    #[cfg(target_os = "macos")]
    {
        let rss = peak_rss_bytes();
        println!(
            "million-path peak RSS after indexing: {} MiB",
            rss / 1_048_576
        );
        assert!(
            rss <= 300 * 1_048_576,
            "million-path RSS exceeded 300 MiB: {} MiB",
            rss / 1_048_576
        );
    }
    let searcher = FileSearcher::default();
    for _ in 0..5 {
        let token = searcher.cancellation().token();
        black_box(searcher.search(&snapshot, "src svc 9999", 100, None, token));
    }
    let mut samples = Vec::with_capacity(40);
    for _ in 0..40 {
        let token = searcher.cancellation().token();
        let started = Instant::now();
        black_box(searcher.search(&snapshot, "src svc 9999", 100, None, token));
        samples.push(started.elapsed());
    }
    samples.sort_unstable();
    let p95 = samples[37];
    println!("million-path warm filename search p95: {p95:?} (budget: {budget:?})");
    assert!(
        filename_budget::within_budget(p95, budget),
        "warm filename p95 exceeded {budget:?}: {p95:?}"
    );
}

#[cfg(target_os = "macos")]
fn peak_rss_bytes() -> u64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: getrusage initializes the supplied rusage structure for this process.
    let status = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    assert_eq!(status, 0, "getrusage failed");
    // SAFETY: a zero status guarantees that getrusage initialized the structure.
    unsafe { usage.assume_init().ru_maxrss as u64 }
}
