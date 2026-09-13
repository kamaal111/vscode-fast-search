use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    thread,
    time::Duration,
};
use tempfile::TempDir;

struct Engine {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Engine {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_fast-search-engine"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("engine starts");
        let input = child.stdin.take().expect("stdin");
        let output = BufReader::new(child.stdout.take().expect("stdout"));
        Self {
            child,
            input,
            output,
        }
    }
    fn send(&mut self, value: Value) {
        writeln!(self.input, "{value}").expect("request writes");
        self.input.flush().expect("request flushes");
    }
    fn next(&mut self) -> Value {
        let mut line = String::new();
        self.output.read_line(&mut line).expect("response reads");
        serde_json::from_str(&line).expect("valid response")
    }
    fn until(&mut self, kind: &str) -> Value {
        loop {
            let value = self.next();
            if value["type"] == kind {
                return value;
            }
        }
    }
    fn wait_for_file(&mut self, query: &str) -> Value {
        for attempt in 0..300 {
            self.send(json!({"type":"fileSearch","version":1,"requestId":format!("refresh-{attempt}"),"query":query,"maxResults":10}));
            let response = self.until("fileResults");
            if response["results"]
                .as_array()
                .is_some_and(|results| !results.is_empty())
            {
                return response;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("filesystem event was not reflected in the searchable snapshot");
    }
    fn wait_for_absent(&mut self, query: &str) {
        for attempt in 0..300 {
            self.send(json!({"type":"fileSearch","version":1,"requestId":format!("absent-{attempt}"),"query":query,"maxResults":10}));
            let response = self.until("fileResults");
            if response["results"].as_array().is_some_and(Vec::is_empty) {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("removed file remained in the searchable snapshot");
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[test]
fn indexes_searches_refreshes_overlays_and_validates_protocol() {
    let first = TempDir::new().expect("first root");
    let second = TempDir::new().expect("second root");
    fs::create_dir(first.path().join("src")).expect("src directory");
    fs::write(
        first.path().join("src/SearchModel.swift"),
        "let greeting = \"Hello Search\"\nlet lower = \"hello search\"\nBEGIN\nmiddle\nEND\nwhole needle needles\n😀 café target\n",
    )
    .expect("source file");
    fs::write(first.path().join("ignored.txt"), "secret phrase").expect("ignored file");
    fs::write(first.path().join(".gitignore"), "ignored.txt\n").expect("ignore file");
    fs::write(second.path().join("README.md"), "hello documentation\n").expect("second file");
    fs::write(first.path().join("scoped.tmp"), "first scoped").expect("first scoped file");
    fs::write(second.path().join("scoped.tmp"), "second scoped").expect("second scoped file");
    fs::write(first.path().join("latin1.txt"), b"caf\xe9 needle\r\n").expect("encoded file");
    fs::write(first.path().join("spaced file.txt"), "disk spaced content").expect("spaced file");
    let mut engine = Engine::start();

    engine.send(json!({"type":"initialize","version":1,"requestId":"init","roots":[{"id":"one","path":first.path()},{"id":"two","path":second.path()}],"configuration":{"excludes":[],"rootExcludes":{"one":["scoped.tmp"]},"useIgnoreFiles":true,"followSymlinks":false}}));
    let ready = engine.until("indexReady");
    assert_eq!(ready["requestId"], "init");
    assert_eq!(ready["fileCount"], 6);

    engine.send(json!({"type":"fileSearch","version":1,"requestId":"scoped","query":"scoped tmp","maxResults":100}));
    let scoped = engine.until("fileResults");
    assert_eq!(scoped["results"].as_array().map(Vec::len), Some(1));
    assert_eq!(scoped["results"][0]["rootId"], "two");

    engine.send(json!({"type":"fileSearch","version":1,"requestId":"encoded-uri","query":"spaced file","maxResults":100}));
    let encoded_uri = engine.until("fileResults");
    assert!(
        encoded_uri["results"][0]["uri"]
            .as_str()
            .is_some_and(|uri| uri.ends_with("spaced%20file.txt"))
    );
    let spaced_uri = encoded_uri["results"][0]["uri"]
        .as_str()
        .expect("encoded URI")
        .to_owned();
    engine.send(json!({"type":"textSearch","version":1,"requestId":"spaced-overlay","query":"overlay for spaced path","options":{"encoding":null,"regex":false,"caseSensitive":false,"smartCase":true,"wholeWord":false,"multiline":false,"includes":[],"excludes":[],"useExcludes":true,"maxResults":20},"overlays":[{"uri":spaced_uri,"text":"overlay for spaced path\n","untitled":false}]}));
    assert_eq!(
        engine.until("textResultBatch")["results"][0]["preview"],
        "overlay for spaced path"
    );
    assert_eq!(engine.until("textSearchComplete")["resultCount"], 1);

    engine.send(json!({"type":"fileSearch","version":1,"requestId":"files","query":"srch mdl:7:2","maxResults":100}));
    let files = engine.until("fileResults");
    assert_eq!(files["results"][0]["relativePath"], "src/SearchModel.swift");
    assert_eq!(files["results"][0]["line"], 7);
    assert_eq!(files["results"][0]["column"], 2);

    fs::write(first.path().join("NewFile.swift"), "disk is stale\n").expect("new file");
    assert_eq!(
        engine.wait_for_file("newfile")["results"][0]["relativePath"],
        "NewFile.swift"
    );
    fs::create_dir(first.path().join("generated")).expect("new directory");
    fs::rename(
        first.path().join("NewFile.swift"),
        first.path().join("generated/RenamedFile.swift"),
    )
    .expect("rename file");
    assert_eq!(
        engine.wait_for_file("renamedfile")["results"][0]["relativePath"],
        "generated/RenamedFile.swift"
    );
    engine.wait_for_absent("newfile");
    fs::remove_file(first.path().join("generated/RenamedFile.swift")).expect("delete file");
    engine.wait_for_absent("renamedfile");
    fs::write(
        first.path().join("generated/RenamedFile.swift"),
        "disk is stale\n",
    )
    .expect("restore overlay target");
    assert_eq!(
        engine.wait_for_file("renamedfile")["results"][0]["relativePath"],
        "generated/RenamedFile.swift"
    );

    let uri = format!(
        "file://{}",
        first.path().join("generated/RenamedFile.swift").display()
    );
    engine.send(json!({"type":"textSearch","version":1,"requestId":"text","query":"overlay wins","options":{"regex":false,"caseSensitive":false,"smartCase":true,"wholeWord":false,"multiline":false,"includes":[],"excludes":[],"useExcludes":true,"maxResults":20},"overlays":[{"uri":uri,"text":"overlay wins here\n","untitled":false}]}));
    let batch = engine.until("textResultBatch");
    assert_eq!(batch["results"][0]["preview"], "overlay wins here");
    assert_eq!(engine.until("textSearchComplete")["resultCount"], 1);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"regex-case","query":"Hello\\s+Search","options":{"encoding":null,"regex":true,"caseSensitive":true,"smartCase":false,"wholeWord":false,"multiline":false,"includes":["src/**"],"excludes":[],"useExcludes":true,"maxResults":20},"overlays":[]}));
    assert_eq!(engine.until("textResultBatch")["results"][0]["line"], 0);
    assert_eq!(engine.until("textSearchComplete")["resultCount"], 1);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"whole","query":"needle","options":{"encoding":null,"regex":false,"caseSensitive":false,"smartCase":true,"wholeWord":true,"multiline":false,"includes":["src/**"],"excludes":[],"useExcludes":true,"maxResults":20},"overlays":[]}));
    assert_eq!(
        engine.until("textResultBatch")["results"][0]["preview"],
        "whole needle needles"
    );
    assert_eq!(engine.until("textSearchComplete")["resultCount"], 1);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"multiline","query":"BEGIN.*END","options":{"encoding":null,"regex":true,"caseSensitive":true,"smartCase":false,"wholeWord":false,"multiline":true,"includes":[],"excludes":[],"useExcludes":true,"maxResults":20},"overlays":[]}));
    let multiline = engine.until("textResultBatch");
    assert_eq!(multiline["results"][0]["line"], 2);
    assert_eq!(multiline["results"][0]["endLine"], 4);
    assert_eq!(engine.until("textSearchComplete")["resultCount"], 1);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"unicode-range","query":"target","options":{"encoding":null,"regex":false,"caseSensitive":true,"smartCase":false,"wholeWord":false,"multiline":false,"includes":["src/**"],"excludes":[],"useExcludes":true,"maxResults":20},"overlays":[]}));
    let unicode = engine.until("textResultBatch");
    assert_eq!(unicode["results"][0]["line"], 6);
    assert_eq!(unicode["results"][0]["startColumn"], 8);
    assert_eq!(unicode["results"][0]["endColumn"], 14);
    assert_eq!(engine.until("textSearchComplete")["resultCount"], 1);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"limit","query":"hello search","options":{"encoding":null,"regex":false,"caseSensitive":false,"smartCase":false,"wholeWord":false,"multiline":false,"includes":[],"excludes":[],"useExcludes":true,"maxResults":1},"overlays":[]}));
    assert_eq!(
        engine.until("textResultBatch")["results"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    let limited = engine.until("textSearchComplete");
    assert_eq!(limited["resultCount"], 1);
    assert_eq!(limited["limitHit"], true);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"untitled","query":"only in an untitled editor","options":{"encoding":null,"regex":false,"caseSensitive":false,"smartCase":true,"wholeWord":false,"multiline":false,"includes":[],"excludes":[],"useExcludes":true,"maxResults":20},"overlays":[{"uri":"untitled:Untitled-1","text":"only in an untitled editor\n","untitled":true}]}));
    let untitled = engine.until("textResultBatch");
    assert_eq!(untitled["results"][0]["uri"], "untitled:Untitled-1");
    assert_eq!(untitled["results"][0]["rootId"], "untitled");
    assert_eq!(engine.until("textSearchComplete")["resultCount"], 1);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"ignored","query":"secret phrase","options":{"encoding":null,"regex":false,"caseSensitive":false,"smartCase":true,"wholeWord":false,"multiline":false,"includes":[],"excludes":[],"useExcludes":false,"maxResults":20},"overlays":[]}));
    assert_eq!(
        engine.until("textResultBatch")["results"][0]["preview"],
        "secret phrase"
    );
    assert_eq!(engine.until("textSearchComplete")["resultCount"], 1);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"encoding","query":"café needle","options":{"encoding":"windows-1252","regex":false,"caseSensitive":false,"smartCase":true,"wholeWord":false,"multiline":false,"includes":[],"excludes":[],"useExcludes":true,"maxResults":20},"overlays":[]}));
    assert_eq!(
        engine.until("textResultBatch")["results"][0]["preview"],
        "café needle"
    );
    assert_eq!(engine.until("textSearchComplete")["resultCount"], 1);

    writeln!(engine.input, "not-json").expect("malformed request writes");
    engine.input.flush().expect("malformed request flushes");
    assert_eq!(engine.until("requestError")["code"], "invalidMessage");
    engine.send(json!({"type":"shutdown","version":1,"requestId":"bye"}));
    assert_eq!(engine.until("diagnostics")["requestId"], "bye");
}

#[test]
fn publishes_searchable_partial_snapshots_during_initial_indexing() {
    let first = TempDir::new().expect("first root");
    let slow = TempDir::new().expect("slow root");
    fs::write(first.path().join("AlreadyVisible.swift"), "visible").expect("first file");
    for index in 0..4_000 {
        fs::write(
            slow.path().join(format!("Generated{index:04}.txt")),
            "generated",
        )
        .expect("generated fixture");
    }
    let mut engine = Engine::start();
    engine.send(json!({"type":"initialize","version":1,"requestId":"partial-init","roots":[{"id":"first","path":first.path()},{"id":"slow","path":slow.path()}],"configuration":{"excludes":[],"useIgnoreFiles":true,"followSymlinks":false}}));
    let progress = engine.until("indexProgress");
    assert_eq!(progress["rootId"], "first");
    assert_eq!(progress["filesIndexed"], 1);
    engine.send(json!({"type":"fileSearch","version":1,"requestId":"partial-search","query":"already visible","maxResults":10}));
    let results = engine.until("fileResults");
    assert_eq!(results["requestId"], "partial-search");
    assert_eq!(results["partial"], true);
    assert_eq!(
        results["results"][0]["relativePath"],
        "AlreadyVisible.swift"
    );
    assert_eq!(engine.until("indexReady")["fileCount"], 4_001);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"survives-stale-cancel","query":"generated","options":{"encoding":null,"regex":false,"caseSensitive":false,"smartCase":true,"wholeWord":false,"multiline":false,"includes":[],"excludes":[],"useExcludes":true,"maxResults":4_000},"overlays":[]}));
    engine.send(json!({"type":"cancel","version":1,"requestId":"stale-cancel","targetRequestId":"an-old-request"}));
    let complete = engine.until("textSearchComplete");
    assert_eq!(complete["requestId"], "survives-stale-cancel");
    assert_eq!(complete["cancelled"], false);
    assert_eq!(complete["resultCount"], 4_000);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"cancel-me","query":"absent value","options":{"encoding":null,"regex":false,"caseSensitive":false,"smartCase":true,"wholeWord":false,"multiline":false,"includes":[],"excludes":[],"useExcludes":true,"maxResults":4_000},"overlays":[]}));
    engine.send(json!({"type":"cancel","version":1,"requestId":"real-cancel","targetRequestId":"cancel-me"}));
    let cancelled = engine.until("textSearchComplete");
    assert_eq!(cancelled["requestId"], "cancel-me");
    assert_eq!(cancelled["cancelled"], true);
}
