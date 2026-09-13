use fast_search_core::{TextResultSink, TextSearcher};
use fast_search_index::{IndexedPath, Snapshot, character_bag};
use fast_search_protocol::{TextMatch, TextSearchOptions};
use std::{
    fs,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

#[derive(Default)]
struct TimingSink {
    started: Mutex<Option<Instant>>,
    first_batch: Mutex<Option<Duration>>,
}

impl TimingSink {
    fn start(&self) {
        *self.started.lock().expect("start lock") = Some(Instant::now());
    }
}

impl TextResultSink for TimingSink {
    fn emit(&self, _results: Vec<TextMatch>) {
        let started = *self.started.lock().expect("start lock");
        let mut first = self.first_batch.lock().expect("batch lock");
        if first.is_none() {
            *first = started.map(|value| value.elapsed());
        }
    }
}

fn main() {
    let workspace = tempfile::tempdir().expect("temporary corpus");
    let root_path = Arc::new(workspace.path().to_path_buf());
    let root_id: Arc<str> = Arc::from("corpus");
    let body = format!(
        "{}\nneedle in generated corpus\n",
        "ordinary text ".repeat(300)
    );
    let files: Vec<_> = (0..10_000)
        .map(|index| {
            let relative = format!("generated/Corpus{index:05}.txt");
            let absolute = root_path.join(&relative);
            fs::create_dir_all(absolute.parent().expect("parent")).expect("create corpus folder");
            fs::write(&absolute, &body).expect("write corpus file");
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
    let options = TextSearchOptions {
        encoding: None,
        regex: false,
        case_sensitive: false,
        smart_case: true,
        whole_word: false,
        multiline: false,
        includes: Vec::new(),
        excludes: Vec::new(),
        use_excludes: true,
        max_results: 10_000,
    };

    let searcher = TextSearcher::default();
    let sink = TimingSink::default();
    sink.start();
    searcher
        .search(
            &snapshot,
            "needle in generated corpus",
            &options,
            &[],
            &sink,
            searcher.cancellation().token(),
        )
        .expect("content search");
    let first_batch = sink
        .first_batch
        .lock()
        .expect("batch lock")
        .expect("at least one result batch");
    println!("generated-corpus first batch: {first_batch:?}");
    assert!(
        first_batch <= Duration::from_millis(250),
        "first batch exceeded 250 ms: {first_batch:?}"
    );

    let cancelling = TextSearcher::default();
    let cancellation = cancelling.cancellation();
    let token = cancellation.token();
    let cancel_snapshot = snapshot.clone();
    let cancel_options = options.clone();
    let task = thread::spawn(move || {
        cancelling.search(
            &cancel_snapshot,
            "a value absent from every generated file",
            &cancel_options,
            &[],
            &TimingSink::default(),
            token,
        )
    });
    thread::sleep(Duration::from_millis(5));
    let cancelled_at = Instant::now();
    cancellation.cancel();
    let summary = task
        .join()
        .expect("search thread")
        .expect("cancelled search");
    let acknowledgement = cancelled_at.elapsed();
    println!("generated-corpus cancellation acknowledgement: {acknowledgement:?}");
    assert!(
        summary.cancelled,
        "search completed before observing cancellation"
    );
    assert!(
        acknowledgement <= Duration::from_millis(50),
        "cancellation acknowledgement exceeded 50 ms: {acknowledgement:?}"
    );
}
