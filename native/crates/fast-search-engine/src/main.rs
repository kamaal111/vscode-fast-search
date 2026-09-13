use fast_search_core::{FileSearcher, TextResultSink, TextSearcher};
use fast_search_index::{IndexOptions, RootSpec, WorkspaceIndex};
use fast_search_protocol::{PROTOCOL_VERSION, Request, Response};
use notify::{Config, PollWatcher, RecursiveMode, Watcher};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::Duration,
};

fn main() {
    let index = WorkspaceIndex::default();
    let file_searcher = FileSearcher::default();
    let text_searcher = TextSearcher::default();
    let active_file_request = Arc::new(Mutex::new(None::<String>));
    let active_text_request = Arc::new(Mutex::new(None::<String>));
    let mut watcher: Option<PollWatcher> = None;
    let (responses, receiver) = mpsc::channel::<Response>();
    thread::spawn(move || {
        let stdout = io::stdout();
        let mut output = stdout.lock();
        while let Ok(response) = receiver.recv() {
            match serde_json::to_writer(&mut output, &response) {
                Ok(()) => {
                    let _ = output.write_all(b"\n");
                    let _ = output.flush();
                }
                Err(error) => eprintln!("failed to encode protocol response: {error}"),
            }
        }
    });

    for line in io::stdin().lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("stdin error: {error}");
                break;
            }
        };
        let request = match serde_json::from_str::<Request>(&line) {
            Ok(request) => request,
            Err(error) => {
                let _ = responses.send(Response::RequestError {
                    version: PROTOCOL_VERSION,
                    request_id: "unknown".into(),
                    code: "invalidMessage".into(),
                    message: error.to_string(),
                });
                continue;
            }
        };
        let request_id = request.request_id().to_owned();
        if request.version() != PROTOCOL_VERSION {
            let _ = responses.send(Response::RequestError {
                version: PROTOCOL_VERSION,
                request_id,
                code: "versionMismatch".into(),
                message: format!("expected protocol version {PROTOCOL_VERSION}"),
            });
            continue;
        }
        match request {
            Request::Initialize {
                request_id,
                roots,
                configuration,
                ..
            }
            | Request::Reconfigure {
                request_id,
                roots,
                configuration,
                ..
            } => {
                let specs: Vec<_> = roots
                    .into_iter()
                    .map(|root| RootSpec {
                        id: root.id,
                        path: PathBuf::from(root.path),
                    })
                    .collect();
                let prepared_watcher = prepare_watcher(&specs);
                let watch_events = match prepared_watcher {
                    Ok((new_watcher, receiver)) => {
                        watcher = Some(new_watcher);
                        Some(receiver)
                    }
                    Err(message) => {
                        eprintln!("filesystem watcher unavailable: {message}");
                        watcher = None;
                        None
                    }
                };
                let index = index.clone();
                let output = responses.clone();
                thread::spawn(move || {
                    match index.configure_with_progress(
                        specs,
                        IndexOptions {
                            excludes: configuration.excludes,
                            root_excludes: configuration.root_excludes,
                            use_ignore_files: configuration.use_ignore_files,
                            use_ignore_files_by_root: configuration.use_ignore_files_by_root,
                            follow_symlinks: configuration.follow_symlinks,
                            follow_symlinks_by_root: configuration.follow_symlinks_by_root,
                        },
                        |root, files_indexed| {
                            let _ = output.send(Response::IndexProgress {
                                version: PROTOCOL_VERSION,
                                request_id: request_id.clone(),
                                root_id: root.id.clone(),
                                files_indexed,
                            });
                        },
                    ) {
                        Ok(mut snapshot) => {
                            if let Some(receiver) = watch_events {
                                replay_initial_changes(&index, &receiver);
                                snapshot = index.searchable_snapshot();
                                watch_for_changes(index.clone(), receiver);
                            }
                            let _ = output.send(Response::IndexReady {
                                version: PROTOCOL_VERSION,
                                request_id,
                                file_count: snapshot.files.len(),
                            });
                        }
                        Err(message) => {
                            let _ = output.send(Response::RequestError {
                                version: PROTOCOL_VERSION,
                                request_id,
                                code: "indexFailed".into(),
                                message,
                            });
                        }
                    }
                });
            }
            Request::FileSearch {
                request_id,
                query,
                max_results,
                active_editor,
                ..
            } => {
                file_searcher.cancellation().cancel();
                let token = file_searcher.cancellation().token();
                *active_file_request
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(request_id.clone());
                let snapshot = index.searchable_snapshot();
                let partial = !index.diagnostics().ready;
                let searcher = file_searcher.clone();
                let output = responses.clone();
                let active_request = Arc::clone(&active_file_request);
                let active_request_id = request_id.clone();
                thread::spawn(move || {
                    let results = searcher.search(
                        &snapshot,
                        &query,
                        max_results,
                        active_editor.as_ref(),
                        token,
                    );
                    let _ = output.send(Response::FileResults {
                        version: PROTOCOL_VERSION,
                        request_id,
                        results,
                        partial,
                    });
                    let mut active = active_request
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    if active.as_deref() == Some(&active_request_id) {
                        *active = None;
                    }
                });
            }
            Request::TextSearch {
                request_id,
                query,
                options,
                overlays,
                ..
            } => {
                text_searcher.cancellation().cancel();
                let token = text_searcher.cancellation().token();
                *active_text_request
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(request_id.clone());
                let snapshot = index
                    .query_snapshot(options.use_excludes)
                    .unwrap_or_else(|error| {
                        eprintln!("query-specific walk failed: {error}");
                        index.searchable_snapshot()
                    });
                let searcher = text_searcher.clone();
                let output = responses.clone();
                let active_request = Arc::clone(&active_text_request);
                let active_request_id = request_id.clone();
                thread::spawn(move || {
                    let sink = ProtocolSink {
                        request_id: request_id.clone(),
                        output: output.clone(),
                        count: Mutex::new(0),
                    };
                    match searcher.search(&snapshot, &query, &options, &overlays, &sink, token) {
                        Ok(summary) => {
                            let result_count =
                                *sink.count.lock().unwrap_or_else(|error| error.into_inner());
                            let _ = output.send(Response::TextSearchComplete {
                                version: PROTOCOL_VERSION,
                                request_id,
                                result_count,
                                limit_hit: summary.limit_hit,
                                cancelled: summary.cancelled,
                                warnings: summary.warnings,
                            });
                        }
                        Err(message) => {
                            let _ = output.send(Response::RequestError {
                                version: PROTOCOL_VERSION,
                                request_id,
                                code: "invalidQuery".into(),
                                message,
                            });
                        }
                    }
                    let mut active = active_request
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    if active.as_deref() == Some(&active_request_id) {
                        *active = None;
                    }
                });
            }
            Request::Cancel {
                request_id,
                target_request_id,
                ..
            } => {
                if active_file_request
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .as_deref()
                    == Some(&target_request_id)
                {
                    file_searcher.cancellation().cancel();
                }
                if active_text_request
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .as_deref()
                    == Some(&target_request_id)
                {
                    text_searcher.cancellation().cancel();
                }
                let d = index.diagnostics();
                let _ = responses.send(Response::Diagnostics {
                    version: PROTOCOL_VERSION,
                    request_id,
                    ready: d.ready,
                    file_count: d.file_count,
                    roots: d.roots,
                    generation: d.generation,
                    last_error: d.last_error,
                });
            }
            Request::Status { request_id, .. } => {
                let d = index.diagnostics();
                let _ = responses.send(Response::Diagnostics {
                    version: PROTOCOL_VERSION,
                    request_id,
                    ready: d.ready,
                    file_count: d.file_count,
                    roots: d.roots,
                    generation: d.generation,
                    last_error: d.last_error,
                });
            }
            Request::Shutdown { request_id, .. } => {
                let d = index.diagnostics();
                let _ = responses.send(Response::Diagnostics {
                    version: PROTOCOL_VERSION,
                    request_id,
                    ready: d.ready,
                    file_count: d.file_count,
                    roots: d.roots,
                    generation: d.generation,
                    last_error: d.last_error,
                });
                break;
            }
        }
    }
    drop(watcher);
}

type WatchEvents = mpsc::Receiver<notify::Result<notify::Event>>;

fn prepare_watcher(roots: &[RootSpec]) -> Result<(PollWatcher, WatchEvents), String> {
    let (events, receiver) = mpsc::channel();
    let mut watcher = PollWatcher::new(
        move |event| {
            let _ = events.send(event);
        },
        Config::default().with_poll_interval(Duration::from_millis(100)),
    )
    .map_err(|error| error.to_string())?;
    for root in roots {
        watcher
            .watch(&root.path, RecursiveMode::Recursive)
            .map_err(|error| error.to_string())?;
    }
    Ok((watcher, receiver))
}

fn watch_for_changes(index: WorkspaceIndex, receiver: WatchEvents) {
    thread::spawn(move || {
        while let Ok(first) = receiver.recv() {
            let mut changed_paths = first.map(|event| event.paths).unwrap_or_default();
            while let Ok(event) = receiver.recv_timeout(Duration::from_millis(40)) {
                if let Ok(event) = event {
                    changed_paths.extend(event.paths);
                }
            }
            if let Err(error) = index.apply_filesystem_changes(&changed_paths) {
                eprintln!("filesystem refresh failed: {error}");
            }
        }
    });
}

fn replay_initial_changes(index: &WorkspaceIndex, receiver: &WatchEvents) {
    let mut changed_paths = Vec::new();
    while let Ok(event) = receiver.recv_timeout(Duration::from_millis(40)) {
        if let Ok(event) = event {
            changed_paths.extend(event.paths);
        }
    }
    if !changed_paths.is_empty()
        && let Err(error) = index.apply_filesystem_changes(&changed_paths)
    {
        eprintln!("initial filesystem replay failed: {error}");
    }
}

struct ProtocolSink {
    request_id: String,
    output: mpsc::Sender<Response>,
    count: Mutex<usize>,
}
impl TextResultSink for ProtocolSink {
    fn emit(&self, results: Vec<fast_search_protocol::TextMatch>) {
        let mut count = self.count.lock().unwrap_or_else(|error| error.into_inner());
        *count += results.len();
        let _ = self.output.send(Response::TextResultBatch {
            version: PROTOCOL_VERSION,
            request_id: self.request_id.clone(),
            results,
        });
    }
}
